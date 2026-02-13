import path from 'node:path';
import fs from 'node:fs';
const CONFIG_PATH = path.join(process.cwd(), 'mcp-orchestrator.config.json');
export function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { mcps: {}, workflows: [] };
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
export function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}
