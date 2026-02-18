#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestratorConfig } from './config.js';
import { listAllTools, runWorkflow } from './workflow.js';
import { bootstrapSecretsFromKeychain } from './secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig(configPath?: string): OrchestratorConfig {
  const p = configPath ?? path.join(process.cwd(), 'porch.config.json');
  if (!fs.existsSync(p)) {
    const example = path.join(__dirname, '..', 'porch.config.example.json');
    const legacy = path.join(process.cwd(), 'mcp-orchestrator.config.json');
    if (fs.existsSync(legacy)) {
      return JSON.parse(fs.readFileSync(legacy, 'utf8')) as OrchestratorConfig;
    }
    throw new Error(
      `Config not found at ${p}. Create one from ${example}`,
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as OrchestratorConfig;
}

async function main(): Promise<void> {
  bootstrapSecretsFromKeychain();
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
        console.error('Usage: porch workflow <workflow-name>');
        process.exit(1);
      }
      const { success } = await runWorkflow(config, name);
      process.exit(success ? 0 : 1);
    }

    default:
      console.log(`
Porch - Connect MCPs and automate actions between them

Usage:
  porch list                    List tools from all connected MCPs
  porch workflow <name>         Run a workflow by name
  porch --help                  Show this help

Config: porch.config.json (or --config=/path/to/config.json)

Example workflow: Spotify getRecentlyPlayed → Pieces create_pieces_memory
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
