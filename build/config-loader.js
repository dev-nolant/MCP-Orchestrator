import path from 'node:path';
import fs from 'node:fs';
import { invalidateProxyToolsCache } from './proxy-tools-cache.js';
const CONFIG_PATH = path.join(process.cwd(), 'porch.config.json');
const LEGACY_CONFIG_PATH = path.join(process.cwd(), 'mcp-orchestrator.config.json');
export function loadConfig() {
    const pathToUse = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : fs.existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH : null;
    if (!pathToUse) {
        return { mcps: {}, workflows: [] };
    }
    return JSON.parse(fs.readFileSync(pathToUse, 'utf8'));
}
export function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    invalidateProxyToolsCache();
}
