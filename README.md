# MCP Orchestrator

Connect MCPs locally (via URL or stdio) and automate actions between them. Chain tools from different MCPs—e.g. filesystem `search_files` → memory `create_entities`, or your own MCP combos.

## Contents

- [Setup](#setup)
- [Config](#config)
- [Workflows](#workflows)
- [Easy Install (Mac, Linux, Windows)](#easy-install-mac-linux-windows)
- [Uninstall](#uninstall)
- [Web UI](#web-ui)
- [CLI](#cli)
- [Use as an MCP (Cursor / Claude Desktop)](#use-as-an-mcp-cursor--claude-desktop)
- [Public URL (Tunnel)](#public-url-tunnel)
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

### Bearer tokens (URL MCPs)

For URL MCPs that require a Bearer token, add `authorizationToken`:

```json
"pieces": {
  "type": "url",
  "url": "http://localhost:39300/.../mcp",
  "authorizationToken": "env:MCP_PIECES_TOKEN"
}
```

Supported formats:
- `env:VAR_NAME` — read from `process.env.VAR_NAME` (recommended for CI)
- `secret:key` — read from `mcp-orchestrator.secrets.json` (stored locally, gitignored)
- Plain string — avoid in committed config

Store a token via API: `PUT /api/secrets/:key` with `{ "value": "your-token" }`. Restrict file permissions: `chmod 600 mcp-orchestrator.secrets.json`.

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

**Cloudflared** (for Public URLs / tunnels): The installer prompts to install cloudflared. To skip the prompt:

```bash
./scripts/install.sh --cloudflared    # Install cloudflared
./scripts/install.sh --no-cloudflared # Skip (default when non-interactive)
```

```powershell
.\scripts\install.ps1 -Cloudflared    # Install cloudflared
.\scripts\install.ps1 -NoCloudflared  # Skip
```

**Control scripts:**
- `./scripts/start.sh` / `.\scripts\start.ps1` — start server in background
- `./scripts/stop.sh` / `.\scripts\stop.ps1` — stop server
- `./scripts/update.sh` / `.\scripts\update.ps1` — update (git pull, npm install, build, restart)
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

### Uninstall

**Mac & Linux:**
```bash
cd ~/mcp-orchestrator
./scripts/disable-startup.sh
```
This stops the server and removes the launchd/systemd auto-start entry.

**Windows:**
```powershell
cd ~\mcp-orchestrator
.\scripts\disable-startup.ps1
```
This stops the server and removes the scheduled task.

**Optional cleanup:**
- Remove `127.0.0.1 mcporch.local` from your hosts file (`/etc/hosts` on Mac/Linux, `C:\Windows\System32\drivers\etc\hosts` on Windows).
- Delete the project folder: `rm -rf ~/mcp-orchestrator` (Mac/Linux) or remove `~\mcp-orchestrator` (Windows).

If you used a custom install location, run the scripts from that directory instead of `~/mcp-orchestrator`.

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

## Public URL (Tunnel)

Expose **any MCP** to the internet with token auth. Two options:

### Quick tunnel (no config)

Free, no sign-up. URL changes each start.

1. **Install cloudflared**: `brew install cloudflared`
2. Open the **Public URLs** tab → **Start tunnel**
3. Creates `https://xxx.trycloudflare.com`
4. Generate tokens per MCP; remote clients use URL + Bearer token

### Named tunnel (stable URL)

Requires a Cloudflare account. Same URL every time.

1. **Login** — In the Public URLs tab, click **Login to Cloudflare**. A browser opens; sign in and approve.
2. **Set subdomain base** — Enter your domain (e.g. `mcp.example.com`) in the "Subdomain base" field and Save. The domain must be in your Cloudflare account.
3. **Start tunnel** — Creates a named tunnel, routes DNS (`spotify.mcp.example.com`, `pieces.mcp.example.com`, etc.), and runs. Each MCP gets its own subdomain.

Alternatively, use token-based named tunnel: set `CLOUDFLARE_TUNNEL_TOKEN` and `CLOUDFLARE_TUNNEL_PUBLIC_URL` (or secrets).

**URL MCPs** are tunneled via the orchestrator; **stdio MCPs** use an HTTP-to-stdio bridge. All traffic is proxied and validated with per-MCP tokens. Without the token, access is denied.

**Claude Desktop** example:

```
URL: https://your-tunnel.trycloudflare.com/tunnel/pieces
Authorization: Bearer <your-token>
```

**Cursor** — Add the Streamable HTTP MCP URL and ensure the Bearer token is sent.

**Security:**
- MCP tokens in `mcp-orchestrator.secrets.json`. Use **Revoke** to invalidate.
- Tunnel token/URL: use env vars or secrets; never commit.

## Prerequisites

- **Spotify MCP**: Auth with `npm run auth` in `spotify-mcp-server`
- **Pieces MCP**: Pieces Desktop running (exposes MCP at the configured URL)
