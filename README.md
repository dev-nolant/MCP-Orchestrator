# MCP Orchestrator

Connect MCPs locally (via URL or stdio) and automate actions between them. Chain tools from different MCPs—e.g. filesystem `search_files` → memory `create_entities`, or your own MCP combos.

## Contents

- [Setup](#setup)
- [Config](#config)
- [Workflows](#workflows)
- [Easy Install (Mac, Linux, Windows)](#easy-install-mac-linux-windows)
- [Web UI](#web-ui)
- [CLI](#cli)
- [Use as an MCP (Cursor / Claude Desktop)](#use-as-an-mcp-cursor--claude-desktop)
- [Prerequisites](#prerequisites)

## Setup

```bash
cd mcp-orchestrator
npm install
npm run build
```

## Config

Copy the example and edit for your setup:
```bash
cp mcp-orchestrator.config.example.json mcp-orchestrator.config.json
```
Your config is gitignored and never committed. Two MCP types:

### URL (HTTP/SSE)
For MCPs that expose an HTTP endpoint (e.g. Pieces):

```json
"pieces": {
  "type": "url",
  "url": "http://localhost:39300/model_context_protocol/2025-03-26/mcp"
}
```

### Stdio (spawn process)
For MCPs that run as a process (e.g. Spotify MCP):

```json
"spotify": {
  "type": "stdio",
  "command": "node",
  "args": ["./spotify-mcp-server/build/index.js"],
  "cwd": "./spotify-mcp-server"
}
```

Use absolute paths if running from elsewhere. For the filesystem MCP, replace `/path/to/your/projects` with a directory you want to allow (e.g. your home or a project folder).

## Workflows

Workflows chain steps. Use `{{step0}}`, `{{step1}}`, etc. to inject the text output of a previous step into the next step's args.

Example: Spotify → Pieces

```json
{
  "name": "Spotify to Pieces",
  "steps": [
    { "mcp": "spotify", "tool": "getRecentlyPlayed", "args": { "limit": 15 } },
    {
      "mcp": "pieces",
      "tool": "create_pieces_memory",
      "args": {
        "summary_description": "Spotify listening history",
        "summary": "# Recently Played\n\n{{step0}}"
      }
    }
  ]
}
```

## Easy Install (Mac, Linux, Windows)

One-command installer that runs the server in the background and adds **mcporch.local** so you can open the UI with a friendly URL. By default, the server is set to **auto-start when you log in**.

### One-line install (paste into terminal)

**Mac & Linux:**
```bash
curl -sSL https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.sh | bash
```

**Skip auto-start:**
```bash
curl -sSL https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.sh | bash -s -- --no-startup
```

**Windows PowerShell:**
```powershell
irm https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.ps1 | iex
```

**Windows, skip auto-start:** `$env:NO_STARTUP=1; irm https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.ps1 | iex`

The bootstrap clones the repo to `~/mcp-orchestrator`, runs `npm install` and `npm run build`, then starts the server.

---

**Mac & Linux (manual, after clone):**
```bash
cd mcp-orchestrator
chmod +x scripts/*.sh
./scripts/install.sh
```
Then open **http://mcporch.local:3847** (or http://localhost:3847)

**Windows (PowerShell as Administrator for hosts file):**
```powershell
cd mcp-orchestrator
.\scripts\install.ps1
```
Then open **http://mcporch.local:3847**

**Skip auto-start** (install without auto-start on login):

```bash
./scripts/install.sh --no-startup
```

```powershell
.\scripts\install.ps1 -NoStartup
```

**Control scripts:**
- `./scripts/start.sh` / `.\scripts\start.ps1` — start server in background
- `./scripts/stop.sh` / `.\scripts\stop.ps1` — stop server
- `./scripts/enable-startup.sh` / `.\scripts\enable-startup.ps1` — enable auto-start on login
- `./scripts/disable-startup.sh` / `.\scripts\disable-startup.ps1` — disable auto-start on login
- Logs: `tail -f .mcp-orchestrator.log` (Mac/Linux) or `Get-Content .mcp-orchestrator.log -Wait -Tail 20` (Windows)

The installer adds `127.0.0.1 mcporch.local` to your hosts file (requires sudo/admin on first run).

### Disabling auto-start

If you installed with auto-start enabled and want to turn it off:

**Mac:**
```bash
./scripts/disable-startup.sh
```
This stops the server and removes the launch agent. It will not start on next login.

**Linux:**
```bash
./scripts/disable-startup.sh
```
This stops the server and removes the systemd user service.

**Windows:**
```powershell
.\scripts\disable-startup.ps1
```
This stops the server and removes the scheduled task.

To re-enable auto-start later, run `./scripts/enable-startup.sh` or `.\scripts\enable-startup.ps1`.

## Web UI

```bash
npm run ui
# → http://localhost:3847
```

The UI lets you:

- **Add MCPs** by URL (e.g. `http://localhost:39300/.../mcp`) or by file/stdio (command, args, cwd)
- **Build workflows** by chaining actions from your MCPs; use `{{step0}}`, `{{step1}}` in args to pass output between steps
- **Schedule workflows** to run automatically (cron) via the Schedule tab
- **Run workflows** and view output

Config is saved to `mcp-orchestrator.config.json` in the project directory.

## CLI

```bash
npm run list
npm run workflow -- "Spotify to Pieces"
```

## Run every 30 mins (optional)

To sync Spotify → Pieces automatically every 30 minutes:

**Cron:**
```cron
*/30 * * * * cd /path/to/mcp-orchestrator && npm run workflow -- "Spotify to Pieces"
```

## Use as an MCP (Cursor / Claude Desktop)

MCP Orchestrator exposes its workflows as MCP tools so Cursor, Claude Desktop, or any MCP client can run them.

**Tools exposed:**
- `list_workflows` — List all configured workflows
- `run_workflow` — Run a workflow by name

### Add to Cursor

1. Open **Settings → MCP**.
2. Add a server with **Streamable HTTP** and this URL:
   ```
   http://localhost:3847/mcp
   ```
   If using mcporch.local: `http://mcporch.local:3847/mcp`
3. Restart Cursor.

### Add to Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-orchestrator": {
      "url": "http://localhost:3847/mcp"
    }
  }
}
```

Ensure the MCP Orchestrator server is running (`npm run ui` or via the install scripts) before using the tools.

## Prerequisites

- **Spotify MCP**: Auth with `npm run auth` in `spotify-mcp-server`
- **Pieces MCP**: Pieces Desktop running (exposes MCP at the configured URL)
