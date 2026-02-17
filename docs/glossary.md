# MCP Orchestrator Tools — Glossary

Read this to understand every tool and how to use it.

## Overview

The MCP Orchestrator connects MCPs locally (stdio or URL), runs workflows that chain tools across MCPs, and can expose MCPs publicly via Cloudflare tunnel. **You can use MCPs directly** — no workflow required.

## Direct MCP Access

Each configured MCP's tools are exposed as **proxied tools** with the format `mcpName__toolName`. For example: `spotify__getNowPlaying`, `spotify__createPlaylist`, `pieces__create_pieces_memory`. Call these like any other tool; no workflow needed.

Use `call_tool` when you need to specify mcp/tool explicitly (e.g. dynamic tool selection) or when a proxied tool isn't available.

## Quick Start

1. `list_mcps` — See configured MCPs
2. `get_mcp_status` — Check which MCPs are online
3. `list_workflows` — See workflows
4. `run_workflow` — Run one by name
5. **Direct tools** — Call `spotify__getNowPlaying`, `pieces__create_pieces_memory`, etc.

## Workflow Management

| Tool | Purpose | Key Args |
|------|---------|----------|
| list_workflows | List workflows | (none) |
| get_workflow | Get full workflow | name |
| run_workflow | Execute workflow | name |
| add_workflow | Create workflow | name, steps[], description?, trigger?, schedule? |
| update_workflow | Update workflow | name, steps?, description?, trigger?, schedule? |
| delete_workflow | Delete workflow | name |
| schedule_workflow | Set cron schedule | name, schedule (e.g. "*/30 * * * *") |
| unschedule_workflow | Remove schedule | name |

**Workflow steps:** `{ mcp: string, tool: string, args?: object }`. Use placeholders in args: `{{step0}}` (full output), `{{step1.id}}` (JSON path), `{{step1:regex:pat}}` (single capture), `{{step0:regexAll:pat}}` (all captures as array).

## MCP Connection Management

| Tool | Purpose | Key Args |
|------|---------|----------|
| list_mcps | List MCPs | (none) |
| get_mcp_status | Health check | (none) |
| add_mcp | Add MCP | name, type (stdio\|url), command?, args?, url?, authorizationToken? |
| remove_mcp | Remove MCP | name (fails if workflows use it) |
| enable_mcp | Spin up | name |
| disable_mcp | Spin down | name |
| call_tool | Call a tool by mcp/tool/args | mcp, tool, args? |
| list_tools | List tools per MCP | mcp? (omit for all) |

**Direct use:** Tools are also exposed as `mcpName__toolName` (e.g. `spotify__getNowPlaying`). Call those directly—no workflow needed.

**Gotcha:** MCP must be enabled. Use `enable_mcp` first if disabled.

## Tunnel (Public URLs)

| Tool | Purpose | Key Args |
|------|---------|----------|
| get_tunnel_status | Status, URLs | (none) |
| start_tunnel | Start Cloudflare | (none) |
| stop_tunnel | Stop | (none) |
| set_tunnel_domain | Set base domain | domain |
| cloudflare_login | OAuth login | (none) |
| generate_tunnel_token | Token + URL for MCP | mcpName |
| revoke_tunnel_token | Revoke token | mcpName |

## Registry + NPM

| Tool | Purpose | Key Args |
|------|---------|----------|
| search_registry | Search MCP registry | search?, cursor?, limit? |
| install_from_registry | Install from registry | server (object) |
| install_npm_mcp | Install stdio MCP | package, args? |

## Observability

| Tool | Purpose |
|------|---------|
| get_config | Full config JSON |
| get_logs | Recent logs (limit?) |
| clear_logs | Clear logs |
| orchestrator://config | Resource: config |
| orchestrator://status | Resource: MCP + tunnel status |
| orchestrator://logs | Resource: logs |
| orchestrator://glossary | Resource: this glossary |
