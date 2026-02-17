/**
 * Resolve MCP client config paths and install MCP Orchestrator into them.
 * Preserves existing config, merges our entry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const ENTRY_NAME = 'mcp-orchestrator';
function getConfigPaths(platform) {
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const userProfile = process.env.USERPROFILE || home;
    const paths = {
        cursor: {
            path: platform === 'windows'
                ? path.join(userProfile, '.cursor', 'mcp.json')
                : path.join(home, '.cursor', 'mcp.json'),
            format: 'json',
            client: 'cursor',
        },
        'claude-desktop': {
            path: platform === 'mac'
                ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
                : platform === 'windows'
                    ? path.join(appData, 'Claude', 'claude_desktop_config.json')
                    : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
            format: 'json',
            client: 'claude-desktop',
        },
        windsurf: {
            path: platform === 'windows'
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
function getOrchestratorUrl() {
    const port = process.env.PORT ?? '3847';
    return `http://localhost:${port}/mcp`;
}
function getBridgeCommand(orchestratorDir) {
    const url = getOrchestratorUrl();
    const bridgePath = path.join(orchestratorDir, 'build', 'mcp-bridge.js');
    return {
        command: 'node',
        args: [bridgePath],
        env: { MCP_ORCHESTRATOR_URI: url, MCP_NAME: ENTRY_NAME },
    };
}
function getCursorConfig(orchestratorUrl) {
    return { url: orchestratorUrl };
}
function getClaudeDesktopConfig(orchestratorDir) {
    const bridge = getBridgeCommand(orchestratorDir);
    return {
        command: bridge.command,
        args: bridge.args,
        env: bridge.env,
    };
}
function getWindsurfConfig(orchestratorUrl) {
    return { serverUrl: orchestratorUrl };
}
function getContinueConfig(orchestratorUrl) {
    return {
        type: 'streamable-http',
        url: orchestratorUrl,
    };
}
function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function readJsonSafe(filePath) {
    if (!fs.existsSync(filePath))
        return null;
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function writeJson(filePath, data) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
export function installToClient(platform, client, orchestratorDir) {
    const paths = getConfigPaths(platform);
    const info = paths[client];
    if (!info) {
        return { success: false, path: '', message: 'Unknown client', error: 'Unknown client' };
    }
    const orchestratorUrl = getOrchestratorUrl();
    if (client === 'cursor') {
        const existing = readJsonSafe(info.path);
        const merged = existing && typeof existing === 'object' ? { ...existing } : {};
        merged[ENTRY_NAME] = getCursorConfig(orchestratorUrl);
        writeJson(info.path, merged);
        return { success: true, path: info.path, message: 'Installed to Cursor mcp.json.' };
    }
    if (client === 'claude-desktop') {
        const existing = readJsonSafe(info.path);
        const root = existing && typeof existing === 'object' ? { ...existing } : {};
        if (!root.mcpServers || typeof root.mcpServers !== 'object') {
            root.mcpServers = {};
        }
        const servers = { ...root.mcpServers };
        servers[ENTRY_NAME] = getClaudeDesktopConfig(orchestratorDir);
        root.mcpServers = servers;
        writeJson(info.path, root);
        return { success: true, path: info.path, message: 'Installed to Claude Desktop config.' };
    }
    if (client === 'windsurf') {
        const existing = readJsonSafe(info.path);
        const merged = existing && typeof existing === 'object' ? { ...existing } : {};
        if (!merged.mcpServers || typeof merged.mcpServers !== 'object') {
            merged.mcpServers = {};
        }
        const servers = { ...merged.mcpServers };
        servers[ENTRY_NAME] = getWindsurfConfig(orchestratorUrl);
        merged.mcpServers = servers;
        writeJson(info.path, merged);
        return { success: true, path: info.path, message: 'Installed to Windsurf mcp_config.json.' };
    }
    if (client === 'continue') {
        const existing = readJsonSafe(info.path);
        const root = existing && typeof existing === 'object' ? { ...existing } : {};
        if (!root.mcpServers || typeof root.mcpServers !== 'object') {
            root.mcpServers = {};
        }
        const servers = { ...root.mcpServers };
        servers[ENTRY_NAME] = getContinueConfig(orchestratorUrl);
        root.mcpServers = servers;
        writeJson(info.path, root);
        return { success: true, path: info.path, message: 'Installed to Continue config.json.' };
    }
    return { success: false, path: info.path, message: 'Unsupported client', error: 'Unsupported client' };
}
export function getConfigForClient(platform, client, orchestratorDir) {
    const paths = getConfigPaths(platform);
    const info = paths[client];
    if (!info)
        return null;
    const orchestratorUrl = getOrchestratorUrl();
    let config;
    if (client === 'cursor') {
        config = { [ENTRY_NAME]: getCursorConfig(orchestratorUrl) };
    }
    else if (client === 'claude-desktop') {
        config = {
            mcpServers: {
                [ENTRY_NAME]: getClaudeDesktopConfig(orchestratorDir),
            },
        };
    }
    else if (client === 'windsurf') {
        config = {
            mcpServers: {
                [ENTRY_NAME]: getWindsurfConfig(orchestratorUrl),
            },
        };
    }
    else if (client === 'continue') {
        config = {
            mcpServers: {
                [ENTRY_NAME]: getContinueConfig(orchestratorUrl),
            },
        };
    }
    else {
        return null;
    }
    return { config, path: info.path, pathInfo: info };
}
export function detectPlatform() {
    const p = process.platform;
    if (p === 'darwin')
        return 'mac';
    if (p === 'win32')
        return 'windows';
    return 'linux';
}
export { getConfigPaths, ENTRY_NAME };
