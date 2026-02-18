/**
 * Resolve MCP client config paths and install MCP Orchestrator into them.
 * Preserves existing config, merges our entry.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type Platform = 'mac' | 'windows' | 'linux';
export type Client = 'cursor' | 'claude-desktop' | 'windsurf' | 'continue';

const ENTRY_NAME = 'porch';

interface PathInfo {
  path: string;
  format: 'json' | 'yaml';
  client: Client;
}

function getConfigPaths(platform: Platform): Record<Client, PathInfo> {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const userProfile = process.env.USERPROFILE || home;

  const paths: Record<Client, PathInfo> = {
    cursor: {
      path:
        platform === 'windows'
          ? path.join(userProfile, '.cursor', 'mcp.json')
          : path.join(home, '.cursor', 'mcp.json'),
      format: 'json',
      client: 'cursor',
    },
    'claude-desktop': {
      path:
        platform === 'mac'
          ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : platform === 'windows'
            ? path.join(appData, 'Claude', 'claude_desktop_config.json')
            : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      format: 'json',
      client: 'claude-desktop',
    },
    windsurf: {
      path:
        platform === 'windows'
          ? path.join(userProfile, '.codeium', 'windsurf', 'mcp_config.json')
          : path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      format: 'json',
      client: 'windsurf',
    },
    continue: {
      path: path.join(home, '.continue', 'config.json'),
      format: 'json',
      client: 'continue',
    },
  };
  return paths;
}

function getOrchestratorUrl(): string {
  const port = process.env.PORT ?? '3847';
  return `http://localhost:${port}/mcp`;
}

function getBridgeCommand(orchestratorDir: string): { command: string; args: string[]; env: Record<string, string> } {
  const url = getOrchestratorUrl();
  const bridgePath = path.join(orchestratorDir, 'build', 'mcp-bridge.js');
  return {
    command: 'node',
    args: [bridgePath],
    env: { PORCH_URI: url, MCP_ORCHESTRATOR_URI: url, MCP_NAME: ENTRY_NAME },
  };
}

function getCursorConfig(orchestratorUrl: string): object {
  return { url: orchestratorUrl };
}

function getClaudeDesktopConfig(orchestratorDir: string): object {
  const bridge = getBridgeCommand(orchestratorDir);
  return {
    command: bridge.command,
    args: bridge.args,
    env: bridge.env,
  };
}

function getWindsurfConfig(orchestratorUrl: string): object {
  return { serverUrl: orchestratorUrl };
}

function getContinueConfig(orchestratorUrl: string): object {
  return {
    type: 'streamable-http',
    url: orchestratorUrl,
  };
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export interface InstallResult {
  success: boolean;
  path: string;
  message: string;
  error?: string;
}

export function installToClient(
  platform: Platform,
  client: Client,
  orchestratorDir: string,
): InstallResult {
  const paths = getConfigPaths(platform);
  const info = paths[client];
  if (!info) {
    return { success: false, path: '', message: 'Unknown client', error: 'Unknown client' };
  }

  const orchestratorUrl = getOrchestratorUrl();

  if (client === 'cursor') {
    const existing = readJsonSafe(info.path) as Record<string, unknown> | null;
    const merged = existing && typeof existing === 'object' ? { ...existing } : {};
    merged[ENTRY_NAME] = getCursorConfig(orchestratorUrl);
    writeJson(info.path, merged);
    return { success: true, path: info.path, message: 'Installed to Cursor mcp.json.' };
  }

  if (client === 'claude-desktop') {
    const existing = readJsonSafe(info.path) as { mcpServers?: Record<string, unknown> } | null;
    const root = existing && typeof existing === 'object' ? { ...existing } : {};
    if (!root.mcpServers || typeof root.mcpServers !== 'object') {
      root.mcpServers = {};
    }
    const servers = { ...root.mcpServers } as Record<string, unknown>;
    servers[ENTRY_NAME] = getClaudeDesktopConfig(orchestratorDir);
    root.mcpServers = servers;
    writeJson(info.path, root);
    return { success: true, path: info.path, message: 'Installed to Claude Desktop config.' };
  }

  if (client === 'windsurf') {
    const existing = readJsonSafe(info.path) as Record<string, unknown> | null;
    const merged = existing && typeof existing === 'object' ? { ...existing } : {};
    if (!merged.mcpServers || typeof merged.mcpServers !== 'object') {
      merged.mcpServers = {};
    }
    const servers = { ...(merged.mcpServers as Record<string, unknown>) };
    servers[ENTRY_NAME] = getWindsurfConfig(orchestratorUrl);
    merged.mcpServers = servers;
    writeJson(info.path, merged);
    return { success: true, path: info.path, message: 'Installed to Windsurf mcp_config.json.' };
  }

  if (client === 'continue') {
    const existing = readJsonSafe(info.path) as { mcpServers?: Record<string, unknown> } | null;
    const root = existing && typeof existing === 'object' ? { ...existing } : {};
    if (!root.mcpServers || typeof root.mcpServers !== 'object') {
      root.mcpServers = {};
    }
    const servers = { ...root.mcpServers } as Record<string, unknown>;
    servers[ENTRY_NAME] = getContinueConfig(orchestratorUrl);
    root.mcpServers = servers;
    writeJson(info.path, root);
    return { success: true, path: info.path, message: 'Installed to Continue config.json.' };
  }

  return { success: false, path: info.path, message: 'Unsupported client', error: 'Unsupported client' };
}

export function getConfigForClient(
  platform: Platform,
  client: Client,
  orchestratorDir: string,
): { config: unknown; path: string; pathInfo: PathInfo } | null {
  const paths = getConfigPaths(platform);
  const info = paths[client];
  if (!info) return null;

  const orchestratorUrl = getOrchestratorUrl();

  let config: unknown;
  if (client === 'cursor') {
    config = { [ENTRY_NAME]: getCursorConfig(orchestratorUrl) };
  } else if (client === 'claude-desktop') {
    config = {
      mcpServers: {
        [ENTRY_NAME]: getClaudeDesktopConfig(orchestratorDir),
      },
    };
  } else if (client === 'windsurf') {
    config = {
      mcpServers: {
        [ENTRY_NAME]: getWindsurfConfig(orchestratorUrl),
      },
    };
  } else if (client === 'continue') {
    config = {
      mcpServers: {
        [ENTRY_NAME]: getContinueConfig(orchestratorUrl),
      },
    };
  } else {
    return null;
  }

  return { config, path: info.path, pathInfo: info };
}

export function detectPlatform(): Platform {
  const p = process.platform;
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'windows';
  return 'linux';
}

export { getConfigPaths, ENTRY_NAME };
