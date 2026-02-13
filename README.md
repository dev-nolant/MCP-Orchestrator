# MCP Orchestrator

Connect MCPs locally (via URL or stdio) and automate actions between them. Chain tools from different MCPs: e.g. run Spotify's `getRecentlyPlayed` → send the output to Pieces' `create_pieces_memory`.

## Setup

```bash
cd mcp-orchestrator
npm install
npm run build
```

## Config

Create `mcp-orchestrator.config.json` (copy from `mcp-orchestrator.config.example.json`). Two MCP types:

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

Use absolute paths if running from elsewhere.

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
This stops the server and removes the launchd plist. It will not start on next login.

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
- **Run workflows** and view output

Config is saved to `mcp-orchestrator.config.json` in the project directory.

## CLI

```bash
npm run list
npm run workflow -- "Spotify to Pieces"
```

## Run every 30 mins (optional)

To sync Spotify → Pieces automatically every 30 minutes:

**macOS (launchd):** Copy `launchd-spotify-pieces.plist.example` to `~/Library/LaunchAgents/`, update the paths, then:
```bash
launchctl load ~/Library/LaunchAgents/com.mcp-orchestrator.spotify-pieces.plist
```

**Cron:**
```cron
*/30 * * * * cd /path/to/mcp-orchestrator && npm run workflow -- "Spotify to Pieces"
```

## Prerequisites

- **Spotify MCP**: Auth with `npm run auth` in `spotify-mcp-server`
- **Pieces MCP**: Pieces Desktop running (exposes MCP at the configured URL)
