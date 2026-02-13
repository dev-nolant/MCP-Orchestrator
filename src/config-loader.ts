import path from 'node:path';
import fs from 'node:fs';
import type { OrchestratorConfig } from './config.js';

const CONFIG_PATH = path.join(process.cwd(), 'mcp-orchestrator.config.json');

export function loadConfig(): OrchestratorConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { mcps: {}, workflows: [] };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as OrchestratorConfig;
}

export function saveConfig(config: OrchestratorConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}
