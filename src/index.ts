#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import type { OrchestratorConfig } from './config.js';
import { listAllTools, runWorkflow } from './workflow.js';
import { bootstrapSecretsFromKeychain } from './secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
const DEFAULT_PORT = 3847;

function loadConfig(configPath?: string): { config: OrchestratorConfig; configDir: string } {
  const candidates: string[] = [];
  if (configPath) {
    candidates.push(path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath));
  } else {
    candidates.push(path.join(process.cwd(), 'porch.config.json'));
    candidates.push(path.join(PACKAGE_ROOT, 'porch.config.json'));
    candidates.push(path.join(process.cwd(), 'mcp-orchestrator.config.json'));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const config = JSON.parse(fs.readFileSync(p, 'utf8')) as OrchestratorConfig;
      return { config, configDir: path.dirname(p) };
    }
  }

  const example = path.join(PACKAGE_ROOT, 'porch.config.example.json');
  throw new Error(`Config not found. Create one from ${example}`);
}

function getServerUrl(): string {
  return process.env.PORCH_URL ?? `http://127.0.0.1:${process.env.PORT ?? DEFAULT_PORT}`;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${getServerUrl()}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server error ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${getServerUrl()}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server error ${res.status}: ${text}`);
  }
  return res.json();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const configPath = rest.find((a) => a.startsWith('--config='))?.slice(9);

  const opts = { configPath, rest, hasHelp: rest.some((a) => a === '--help' || a === '-h') };
  const getOpt = (name: string) => opts.rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const hasJson = opts.rest.includes('--json');

  const showHelp = (subcommand?: string) => {
    const subcommands = ['list', 'workflow', 'workflows', 'mcps', 'tunnel', 'logs', 'open'];
    if (subcommand && subcommands.includes(subcommand)) {
      const helps: Record<string, string> = {
        list: `porch list - List tools from all connected MCPs

Usage: porch list [--config=PATH] [--help]`,
        workflow: `porch workflow - Run or inspect workflows

Usage:
  porch workflow <name> [--input=JSON] [--config=PATH] [--help]
  porch workflow show <name> [--config=PATH] [--help]

Options:
  --input=JSON     JSON input for {{input.key}} placeholders (or --input=@file.json)
  --config=PATH    Config file path

Examples:
  porch workflow "Spotify to Pieces"
  porch workflow "Start Study" --input='{"subject":"math"}'`,
        workflows: `porch workflows - List workflows

Usage: porch workflows [--json] [--config=PATH] [--help]`,
        mcps: `porch mcps - List MCPs and status

Usage: porch mcps [--json] [--config=PATH] [--help]`,
        tunnel: `porch tunnel - Tunnel status and control

Usage:
  porch tunnel status
  porch tunnel start
  porch tunnel stop

Requires server running (npm run ui).`,
        logs: `porch logs - Recent logs

Usage: porch logs [--tail=N] [--config=PATH] [--help]

Options:
  --tail=N         Last N entries (default: 50)`,
        open: `porch open - Open Porch UI in browser

Usage: porch open [--help]

Opens the Porch UI (default: http://127.0.0.1:3847). Set PORT or PORCH_URL env for custom port/URL.`,
      };
      console.log(helps[subcommand] + '\n');
      return;
    }

    console.log(`
Porch - Connect MCPs and automate actions between them

Usage: porch <command> [options]

Commands:
  list                      List tools from all connected MCPs
  workflow <name>           Run a workflow [--input=JSON]
  workflow show <name>      Show workflow config
  workflows [--json]        List workflows
  mcps [--json]             List MCPs + status
  tunnel status             Tunnel status
  tunnel start|stop         Start or stop tunnel
  logs [--tail=N]           Recent logs
  open                      Open Porch UI in browser
  help [command]            Show help
  --help, -h                Show this help
  --version, -v             Show version

Options:
  --config=PATH             Config file path (default: cwd or package root)

Examples:
  porch workflow "Spotify to Pieces"
  porch workflows --json
  porch tunnel status
`);
  };

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      showHelp(cmd === 'help' ? rest.find((a) => !a.startsWith('-')) : undefined);
      return;
    case '--version':
    case '-v':
      console.log(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
      return;
  }

  if (opts.hasHelp && ['list', 'workflow', 'workflows', 'mcps', 'tunnel', 'logs', 'open'].includes(cmd)) {
    showHelp(cmd);
    return;
  }

  if (cmd === 'open') {
    const url = getServerUrl();
    await open(url);
    console.log(`Opened ${url}`);
    return;
  }

  bootstrapSecretsFromKeychain();
  const { config, configDir } = loadConfig(configPath);

  switch (cmd) {
    case 'list':
      await listAllTools(config);
      break;

    case 'workflow': {
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub === 'show') {
        const name = rest.slice(rest.indexOf('show') + 1).find((a) => !a.startsWith('--'));
        if (!name) {
          console.error('Usage: porch workflow show <name>');
          process.exit(1);
        }
        const w = config.workflows.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? config.workflows.find((x) => x.name === name);
        if (!w) {
          console.error(`Workflow not found: ${name}`);
          process.exit(1);
        }
        console.log(JSON.stringify(w, null, 2));
        break;
      }
      const name = sub ?? rest.find((a) => !a.startsWith('--'));
      if (!name) {
        console.error('Usage: porch workflow <name>');
        process.exit(1);
      }
      let input: Record<string, unknown> | undefined;
      const inputArg = getOpt('input');
      if (inputArg) {
        if (inputArg.startsWith('@')) {
          const fp = path.resolve(process.cwd(), inputArg.slice(1));
          input = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
        } else {
          input = JSON.parse(inputArg) as Record<string, unknown>;
        }
      }
      const { success } = await runWorkflow(config, name, input);
      process.exit(success ? 0 : 1);
    }

    case 'workflows':
      if (hasJson) {
        console.log(JSON.stringify(config.workflows, null, 2));
      } else {
        for (const w of config.workflows) {
          console.log(`  ${w.name}${w.description ? ` - ${w.description}` : ''}`);
        }
      }
      break;

    case 'mcps': {
      if (hasJson) {
        const out = Object.entries(config.mcps).map(([n, m]) => ({
          name: n,
          type: m.type,
          enabled: (m as { enabled?: boolean }).enabled !== false,
        }));
        console.log(JSON.stringify(out, null, 2));
      } else {
        const serverUrl = getServerUrl();
        try {
          const status = (await apiGet('/api/mcp-status')) as { mcps?: { name: string; status: string; tools?: number }[] };
          const mcps = status.mcps ?? [];
          for (const m of mcps) {
            const cfg = config.mcps[m.name];
            const enabled = cfg && (cfg as { enabled?: boolean }).enabled !== false ? '✓' : '✗';
            console.log(`  ${enabled} ${m.name}: ${m.status}${m.tools != null ? ` (${m.tools} tools)` : ''}`);
          }
        } catch {
          for (const [n, m] of Object.entries(config.mcps)) {
            const en = (m as { enabled?: boolean }).enabled !== false ? '✓' : '✗';
            console.log(`  ${en} ${n} (${m.type})`);
          }
        }
      }
      break;
    }

    case 'tunnel': {
      const action = rest.find((a) => !a.startsWith('--'));
      if (!action || !['status', 'start', 'stop'].includes(action)) {
        console.error('Usage: porch tunnel status|start|stop');
        process.exit(1);
      }
      try {
        if (action === 'status') {
          const s = (await apiGet('/api/tunnel/status')) as { active?: boolean; url?: string; baseUrl?: string };
          console.log(s.active ? `Active: ${s.url ?? s.baseUrl ?? 'yes'}` : 'Inactive');
        } else if (action === 'start') {
          const r = (await apiPost('/api/tunnel/start')) as { url?: string };
          console.log(r.url ? `Tunnel started: ${r.url}` : 'Tunnel starting…');
        } else {
          await apiPost('/api/tunnel/stop');
          console.log('Tunnel stopped');
        }
      } catch (err) {
        console.error('Tunnel requires server. Run: npm run ui');
        process.exit(1);
      }
      break;
    }

    case 'logs': {
      const tail = parseInt(getOpt('tail') ?? '50', 10) || 50;
      const logsPath = path.join(configDir, 'porch.logs.json');
      const legacyPath = path.join(configDir, 'mcp-orchestrator.logs.json');
      let logs: unknown[] = [];
      for (const p of [logsPath, legacyPath]) {
        if (fs.existsSync(p)) {
          try {
            logs = JSON.parse(fs.readFileSync(p, 'utf8'));
          } catch {
            /* ignore */
          }
          break;
        }
      }
      if (!Array.isArray(logs)) logs = [];
      const slice = logs.slice(0, tail);
      for (const e of slice) {
        const ev = e as { ts?: string; type?: string; message?: string; success?: boolean };
        const icon = ev.success === false ? '✗' : '✓';
        console.log(`${icon} [${ev.ts ?? ''}] ${ev.type ?? ''}: ${ev.message ?? ''}`);
      }
      break;
    }

    default:
      showHelp();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
