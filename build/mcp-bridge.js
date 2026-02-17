#!/usr/bin/env node
/**
 * Stdio-to-Streamable-HTTP bridge for MCP Orchestrator.
 * Lets stdio-only clients (e.g. Claude Desktop) connect to the orchestrator's HTTP MCP endpoint.
 *
 * Usage: node mcp-bridge.js
 * Env: MCP_ORCHESTRATOR_URI (default: http://localhost:3847/mcp)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uri = process.env.MCP_ORCHESTRATOR_URI || 'http://localhost:3847/mcp';
process.env.URI = uri;
process.env.MCP_NAME = process.env.MCP_NAME || 'mcp-orchestrator';
const adapterPath = path.resolve(__dirname, '../node_modules/@pyroprompts/mcp-stdio-to-streamable-http-adapter/build/cli.js');
const child = spawn(process.execPath, [adapterPath], {
    stdio: 'inherit',
    env: process.env,
});
child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
});
