#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllTools, runWorkflow } from './workflow.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadConfig(configPath) {
    const p = configPath ?? path.join(process.cwd(), 'mcp-orchestrator.config.json');
    if (!fs.existsSync(p)) {
        const example = path.join(__dirname, '..', 'mcp-orchestrator.config.example.json');
        throw new Error(`Config not found at ${p}. Create one from ${example}`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}
async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const configPath = rest.find((a) => a.startsWith('--config='))?.slice(9);
    const config = loadConfig(configPath);
    switch (cmd) {
        case 'list':
            await listAllTools(config);
            break;
        case 'workflow': {
            const name = rest.find((a) => !a.startsWith('--'));
            if (!name) {
                console.error('Usage: mcp-orchestrator workflow <workflow-name>');
                process.exit(1);
            }
            const { success } = await runWorkflow(config, name);
            process.exit(success ? 0 : 1);
        }
        default:
            console.log(`
MCP Orchestrator - Connect MCPs and automate actions between them

Usage:
  mcp-orchestrator list                    List tools from all connected MCPs
  mcp-orchestrator workflow <name>         Run a workflow by name
  mcp-orchestrator --help                  Show this help

Config: mcp-orchestrator.config.json (or --config=/path/to/config.json)

Example workflow: Spotify getRecentlyPlayed → Pieces create_pieces_memory
`);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
