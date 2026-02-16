/**
 * Cloudflare Tunnel for the orchestrator. Supports:
 * - Quick tunnel (no auth): random URL each start
 * - Named tunnel (token): stable URL from your Cloudflare config
 * - Logged-in tunnel: after `cloudflared tunnel login`, create & run with config
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { appendLog } from './logs.js';
import { getSecret } from './secrets.js';
import { toTunnelSubdomain } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_TUNNEL_STATE_PATH = path.join(process.cwd(), 'mcp-orchestrator.secure-tunnel.json');
const CLOUDFLARED_DIR = path.join(os.homedir(), '.cloudflared');
const CLOUDFLARED_CERT = path.join(CLOUDFLARED_DIR, 'cert.pem');

let cloudflareTunnelProcess: ReturnType<typeof spawn> | null = null;
let cloudflareTunnelUrl: string | null = null;

interface OrchestratorTunnelState {
  url: string;
  baseDomain?: string;
  provider?: 'cloudflare_quick' | 'cloudflare_named' | 'cloudflare_logged_in';
}

function loadOrchestratorTunnelState(): OrchestratorTunnelState | null {
  try {
    if (fs.existsSync(ORCHESTRATOR_TUNNEL_STATE_PATH)) {
      const raw = fs.readFileSync(ORCHESTRATOR_TUNNEL_STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as OrchestratorTunnelState;
      if (parsed?.url) return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveOrchestratorTunnelState(state: OrchestratorTunnelState | null): void {
  try {
    if (state) {
      fs.writeFileSync(ORCHESTRATOR_TUNNEL_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } else if (fs.existsSync(ORCHESTRATOR_TUNNEL_STATE_PATH)) {
      fs.unlinkSync(ORCHESTRATOR_TUNNEL_STATE_PATH);
    }
  } catch {
    /* ignore */
  }
}

function getTunnelToken(): string | null {
  return process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim() || getSecret('cloudflare_tunnel_token');
}

function getNamedTunnelPublicUrl(): string | null {
  return process.env.CLOUDFLARE_TUNNEL_PUBLIC_URL?.trim() || getSecret('cloudflare_tunnel_public_url');
}

/** Base domain for subdomain-per-MCP (e.g. mcp.example.com → spotify.mcp.example.com). */
export function getTunnelBaseDomain(): string | null {
  return process.env.CLOUDFLARE_TUNNEL_DOMAIN?.trim() || getSecret('cloudflare_tunnel_domain');
}

function stopCloudflareTunnel(): boolean {
  if (!cloudflareTunnelProcess) return false;
  cloudflareTunnelProcess.kill('SIGTERM');
  cloudflareTunnelProcess = null;
  cloudflareTunnelUrl = null;
  return true;
}

/**
 * Check if user has run `cloudflared tunnel login` (cert.pem exists).
 */
export function isCloudflareLoggedIn(): boolean {
  try {
    return fs.existsSync(CLOUDFLARED_CERT);
  } catch {
    return false;
  }
}

/**
 * Run `cloudflared tunnel login`. Opens browser for OAuth; blocks until user completes or cancels.
 */
export function runCloudflareLogin(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const proc = spawn('cloudflared', ['tunnel', 'login'], spawnOpts());

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        message: 'Login timed out after 5 minutes. Complete the browser flow and try again.',
      });
    }, 300000);

    let stderr = '';
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.stdout?.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        appendLog({ type: 'tunnel', message: 'Cloudflare login succeeded', detail: null, success: true });
        resolve({ success: true, message: 'Logged in. You can now create a named tunnel.' });
      } else {
        const msg =
          stderr.includes('You have successfully logged in') || isCloudflareLoggedIn()
            ? 'Already logged in.'
            : `Login exited with code ${code}. ${stderr.slice(-200).trim() || 'Complete auth in browser.'}`;
        resolve({
          success: isCloudflareLoggedIn(),
          message: msg,
        });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        message: `cloudflared failed: ${err.message}. Install with: brew install cloudflared`,
      });
    });
  });
}

/**
 * Start a Cloudflare quick tunnel (no auth). URL changes each time.
 */
async function startQuickTunnel(port: number): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], spawnOpts());

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        reject(
          new Error(
            'cloudflared did not report URL within 30s. Is cloudflared installed? Run: brew install cloudflared',
          ),
        );
      }
    }, 30000);

    const onOutput = (data: Buffer) => {
      const text = data.toString();
      const m = text.match(/https:\/\/[^\s"'<>|]+\.trycloudflare\.com/);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const url = m[0].replace(/\|/g, '').trim();
        cloudflareTunnelProcess = proc;
        cloudflareTunnelUrl = url;
        saveOrchestratorTunnelState({ url, provider: 'cloudflare_quick' });
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.on('exit', () => {
          cloudflareTunnelProcess = null;
          cloudflareTunnelUrl = null;
          appendLog({
            type: 'tunnel',
            message: 'Cloudflare tunnel closed',
            detail: url,
            success: false,
          });
          console.error('[tunnel] Cloudflare closed:', url);
        });
        resolve({ url });
      }
    };

    proc.stdout?.on('data', onOutput);
    proc.stderr?.on('data', onOutput);
    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(`cloudflared failed: ${err.message}. Install with: brew install cloudflared`),
        );
      }
    });
    proc.on('exit', (code) => {
      if (!resolved && code !== 0 && code !== null) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}

/**
 * Start a Cloudflare named tunnel (token auth). Stable URL from your Cloudflare config.
 */
async function startNamedTunnel(port: number): Promise<{ url: string }> {
  const token = getTunnelToken();
  const publicUrl = getNamedTunnelPublicUrl();

  if (!token) {
    throw new Error(
      'Cloudflare tunnel token required. Set CLOUDFLARE_TUNNEL_TOKEN or add cloudflare_tunnel_token to secrets.',
    );
  }
  if (!publicUrl) {
    throw new Error(
      'Cloudflare tunnel public URL required. Set CLOUDFLARE_TUNNEL_PUBLIC_URL or add cloudflare_tunnel_public_url to secrets. This is the hostname you configured in Cloudflare (e.g. https://mcp.example.com).',
    );
  }

  // Ensure URL has https
  const baseUrl = publicUrl.startsWith('http') ? publicUrl : `https://${publicUrl}`;

  // Ingress is configured in Cloudflare dashboard — ensure it points to http://localhost:PORT
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token', token], spawnOpts());

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        reject(
          new Error(
            'cloudflared named tunnel did not connect within 30s. Check your token and ingress config.',
          ),
        );
      }
    }, 30000);

    const onOutput = (data: Buffer) => {
      const text = data.toString();
      // Named tunnel prints "Connection established" or similar when ready
      if (
        (text.includes('Connection') && text.includes('established')) ||
        text.includes('Registered tunnel connection') ||
        text.includes('INF')
      ) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          cloudflareTunnelProcess = proc;
          cloudflareTunnelUrl = baseUrl;
          saveOrchestratorTunnelState({ url: baseUrl, provider: 'cloudflare_named' });
          proc.stdout?.removeAllListeners();
          proc.stderr?.removeAllListeners();
          proc.on('exit', () => {
            cloudflareTunnelProcess = null;
            cloudflareTunnelUrl = null;
            appendLog({
              type: 'tunnel',
              message: 'Cloudflare named tunnel closed',
              detail: baseUrl,
              success: false,
            });
            console.error('[tunnel] Cloudflare closed:', baseUrl);
          });
          resolve({ url: baseUrl });
        }
      }
    };

    proc.stdout?.on('data', onOutput);
    proc.stderr?.on('data', onOutput);
    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(`cloudflared failed: ${err.message}. Install with: brew install cloudflared`),
        );
      }
    });
    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `cloudflared exited with code ${code}. Ensure your tunnel ingress in Cloudflare routes to http://localhost:${port}.`,
          ),
        );
      }
    });

    // For named tunnels with remote config, cloudflared may not print a clear "ready" message.
    // The tunnel's ingress in Cloudflare dashboard should point to our port.
    // We resolve immediately with the user-provided URL since that's the stable public URL.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        cloudflareTunnelProcess = proc;
        cloudflareTunnelUrl = baseUrl;
        saveOrchestratorTunnelState({ url: baseUrl, provider: 'cloudflare_named' });
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.on('exit', () => {
          cloudflareTunnelProcess = null;
          cloudflareTunnelUrl = null;
        });
        resolve({ url: baseUrl });
      }
    }, 5000);
  });
}

const TUNNEL_NAME = (process.env.MCP_ORCHESTRATOR_TUNNEL_NAME?.trim() || 'mcp-orchestrator').replace(/[/\\:*?"<>|]/g, '-');
const CREDENTIALS_PATH = path.join(CLOUDFLARED_DIR, `${TUNNEL_NAME}-credentials.json`);
const CONFIG_PATH = path.join(CLOUDFLARED_DIR, `${TUNNEL_NAME}-config.yml`);
const CLOUDFLARED_TIMEOUT_MS = 90_000; // tunnel create/route can be slow, esp on Windows

const spawnOpts = (): { stdio: ('ignore' | 'pipe')[]; windowsHide?: boolean } => ({
  stdio: ['ignore', 'pipe', 'pipe'],
  ...(process.platform === 'win32' && { windowsHide: true }),
});

/**
 * Run a cloudflared command and return stdout+stderr. Times out to avoid hangs on Windows.
 */
function runCloudflared(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('cloudflared', args, spawnOpts());
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const finish = (ok: boolean, out: string, err: string, fromTimeout = false) => {
      if (resolved) return;
      resolved = true;
      if (fromTimeout) proc.kill('SIGTERM');
      resolve({ ok, stdout: out, stderr: err });
    };
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      finish(
        false,
        stdout,
        stderr || 'cloudflared timed out (90s). On Windows, ensure cloudflared is in PATH and not blocked by firewall.',
        true,
      );
    }, CLOUDFLARED_TIMEOUT_MS);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (!resolved) finish(code === 0, stdout, stderr, false);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!resolved) finish(false, stdout, err.message, false);
    });
  });
}

/** MCP name + optional config for tunnel subdomain. */
interface McpEntry {
  name: string;
  config?: { tunnelSubdomain?: string } | null;
}

/**
 * Create tunnel if not exists, route DNS for each MCP, run with config.
 */
async function startLoggedInTunnel(
  port: number,
  baseDomain: string,
  mcps: McpEntry[],
): Promise<{ url: string }> {
  const domain = baseDomain.replace(/^\.+/, '').toLowerCase();

  // Ensure .cloudflared exists
  if (!fs.existsSync(CLOUDFLARED_DIR)) {
    fs.mkdirSync(CLOUDFLARED_DIR, { recursive: true });
  }

  const getHostnameTunnelName = () =>
    `mcp-orchestrator-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'device'}`;

  // Resolve tunnel name and paths - prefer existing credentials (default or hostname-based)
  let tunnelName = TUNNEL_NAME;
  let credentialsPath = CREDENTIALS_PATH;
  let configPath = CONFIG_PATH;
  if (!fs.existsSync(credentialsPath)) {
    const hostnameName = getHostnameTunnelName();
    const hostnameCredPath = path.join(CLOUDFLARED_DIR, `${hostnameName}-credentials.json`);
    if (fs.existsSync(hostnameCredPath)) {
      tunnelName = hostnameName;
      credentialsPath = hostnameCredPath;
      configPath = path.join(CLOUDFLARED_DIR, `${hostnameName}-config.yml`);
    }
  }

  // Create tunnel if credentials don't exist
  if (!fs.existsSync(credentialsPath)) {
    const tryCreateWith = async (name: string, credPath: string) => {
      const credPathArg = credPath.replace(/\\/g, '/');
      const create = await runCloudflared([
        'tunnel',
        'create',
        '--credentials-file',
        credPathArg,
        name,
      ]);
      return create;
    };

    let create = await tryCreateWith(tunnelName, credentialsPath);
    if (!create.ok) {
      const stderr = (create.stderr || create.stdout).toLowerCase();
      if (stderr.includes('already exists') || stderr.includes('already registered')) {
        // Default tunnel exists elsewhere (e.g. laptop) - create one unique to this machine
        tunnelName = getHostnameTunnelName();
        credentialsPath = path.join(CLOUDFLARED_DIR, `${tunnelName}-credentials.json`);
        configPath = path.join(CLOUDFLARED_DIR, `${tunnelName}-config.yml`);
        appendLog({ type: 'tunnel', message: `Creating device-specific tunnel: ${tunnelName}`, detail: null });
        create = await tryCreateWith(tunnelName, credentialsPath);
      }
    }
    if (!create.ok) {
      throw new Error(`Failed to create tunnel: ${create.stderr || create.stdout}`);
    }
    appendLog({ type: 'tunnel', message: 'Created Cloudflare tunnel', detail: tunnelName, success: true });
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Tunnel created but credentials file not found at ${credentialsPath}`);
    }
  }

  // Route DNS for each MCP: {subdomain}.{domain}
  for (const { name, config } of mcps) {
    const subdomain = toTunnelSubdomain(name, config);
    const hostname = `${subdomain}.${domain}`;
    const route = await runCloudflared(['tunnel', 'route', 'dns', tunnelName, hostname]);
    if (!route.ok && !route.stderr.includes('already exists') && !route.stderr.includes('record already')) {
      appendLog({
        type: 'tunnel',
        message: `DNS route failed for ${hostname}`,
        detail: route.stderr || route.stdout,
        success: false,
      });
      // Continue - might already exist
    }
  }

  type IngressRule = { hostname?: string; service: string };
  const ingressRules: IngressRule[] = mcps.flatMap(({ name, config }) => {
    const subdomain = toTunnelSubdomain(name, config);
    return [{ hostname: `${subdomain}.${domain}`, service: `http://127.0.0.1:${port}` }];
  });
  ingressRules.push({ service: 'http_status:404' });

  const credentialsPathForConfig = credentialsPath.replace(/\\/g, '/');
  const configYaml = [
    `tunnel: ${tunnelName}`,
    `credentials-file: ${credentialsPathForConfig}`,
    'ingress:',
    ...ingressRules.flatMap((r) =>
      r.hostname
        ? [`  - hostname: ${r.hostname}`, `    service: ${r.service}`]
        : [`  - service: ${r.service}`],
    ),
  ].join('\n');

  fs.writeFileSync(configPath, configYaml, 'utf8');

  const firstSubdomain = toTunnelSubdomain(mcps[0].name, mcps[0].config);
  const baseUrl = `https://${firstSubdomain}.${domain}`;

  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--config', configPath, 'run', tunnelName], spawnOpts());

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        reject(new Error('Tunnel did not connect within 30s'));
      }
    }, 30000);

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        cloudflareTunnelProcess = null;
        cloudflareTunnelUrl = null;
        reject(new Error(`cloudflared failed: ${err.message}. Is cloudflared in PATH? Windows: winget install Cloudflare.cloudflared`));
      }
    });

    proc.on('exit', (code) => {
      cloudflareTunnelProcess = null;
      cloudflareTunnelUrl = null;
      if (!resolved && code !== 0 && code !== null) {
        resolved = true;
        clearTimeout(timeout);
        const out = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-500) || 'no output';
        appendLog({ type: 'tunnel', message: 'cloudflared exited', detail: out, success: false });
        reject(new Error(`cloudflared exited with code ${code}. ${out}`));
      }
    });

    // Resolve after short delay only if process is still running
    setTimeout(() => {
      if (!resolved && (proc.exitCode === null || proc.exitCode === undefined)) {
        resolved = true;
        clearTimeout(timeout);
        cloudflareTunnelProcess = proc;
        cloudflareTunnelUrl = baseUrl;
        saveOrchestratorTunnelState({ url: baseUrl, baseDomain: domain, provider: 'cloudflare_logged_in' });
        resolve({ url: baseUrl });
      }
    }, 5000);
  });
}

/**
 * Start the orchestrator tunnel. Prefers: logged-in+domain > token > quick tunnel.
 */
/** MCP entry for tunnel: name + optional config for subdomain override. */
export interface StartTunnelMcpOption {
  name: string;
  config?: { tunnelSubdomain?: string } | null;
}

export async function startOrchestratorTunnel(
  port: number,
  options?: { mcpNames?: string[]; mcps?: StartTunnelMcpOption[] },
): Promise<{ url: string }> {
  if (cloudflareTunnelProcess && cloudflareTunnelUrl) {
    return { url: cloudflareTunnelUrl };
  }

  const token = getTunnelToken();
  if (token) {
    return startNamedTunnel(port);
  }

  const baseDomain = getTunnelBaseDomain();
  const mcps = options?.mcps;
  if (isCloudflareLoggedIn() && baseDomain && mcps?.length) {
    return startLoggedInTunnel(port, baseDomain, mcps);
  }

  return startQuickTunnel(port);
}

export function stopOrchestratorTunnel(): boolean {
  return stopCloudflareTunnel();
}

export function getOrchestratorTunnelUrl(): string | null {
  return cloudflareTunnelUrl;
}

export function isCloudflareTunnelActive(): boolean {
  if (!cloudflareTunnelProcess) return false;
  // Process may have exited without clearing our ref (e.g. server restarted, crash)
  const exitCode = cloudflareTunnelProcess.exitCode;
  if (exitCode !== null && exitCode !== undefined) {
    cloudflareTunnelProcess = null;
    cloudflareTunnelUrl = null;
    return false;
  }
  return true;
}

export function isNamedTunnelConfigured(): boolean {
  return !!getTunnelToken();
}

export function getOrchestratorTunnelPersisted(): OrchestratorTunnelState | null {
  return loadOrchestratorTunnelState();
}
