<a name="top"></a>

# MCP Orchestrator

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6)](https://www.typescriptlang.org/)
[![OS](https://img.shields.io/badge/OS-Linux%2C%20Windows%2C%20macOS-0078D4)](https://github.com/dev-nolant/MCP-Orchestrator)
[![GitHub release](https://img.shields.io/github/v/release/dev-nolant/MCP-Orchestrator)](https://github.com/dev-nolant/MCP-Orchestrator/releases)

⭐ **Star us on GitHub** — it helps others discover the project!

[![Share on X](https://img.shields.io/badge/share-000000?logo=x&logoColor=white)](https://x.com/intent/tweet?text=Check%20out%20MCP%20Orchestrator%20%E2%80%94%20connect%20and%20chain%20MCPs%20locally%20https://github.com/dev-nolant/MCP-Orchestrator%20%23MCP%20%23AI)
[![Share on LinkedIn](https://img.shields.io/badge/share-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/sharing/share-offsite/?url=https://github.com/dev-nolant/MCP-Orchestrator)

Your MCPs don't talk to each other. MCP Orchestrator discovers and installs MCPs from npm and PyPI, connects them by URL or stdio, chains their tools in workflows, tunnels any MCP to the internet (quick or named, per-MCP tokens), and lets your favorite LLM add MCPs, build workflows, manage the tunnel, and run it all from chat. Web UI, Easy Install for Cursor, Claude, Windsurf, and Continue, CLI, one-command bootstrap with auto-start.

## Table of Contents

- [Setup](#setup)
- [Config](#config)
- [Workflows](#workflows)
- [Easy Install (Mac, Linux, Windows)](#easy-install-mac-linux-windows)
- [Uninstall](#uninstall)
- [Connect (MCP Client Setup)](#connect-mcp-client-setup)
- [Web UI](#web-ui)
- [CLI](#cli)
- [Use as an MCP](#use-as-an-mcp)
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

Store a token via API: `PUT /api/secrets/:key` with `{ "value": "your-token" }`.

### Encrypted secrets (recommended)

When a master key is available, secrets are stored **encrypted** (AES-256-GCM) in `mcp-orchestrator.secrets.json`. The key is stored in the **OS keychain** (macOS Keychain, Windows Credential Manager, Linux Secret Service)—no plain-text key file.

**Install script** prompts for a password and stores the derived key in the OS keychain. No files with secrets.

**Manual setup:** run `npm run setup-encryption` and enter a password (min 8 chars). Or use the Settings UI: enter a password and click "Set up encryption". Existing secrets are re-encrypted immediately.

**Override:** set `MCP_ORCHESTRATOR_MASTER_KEY` (base64 32-byte key or passphrase) in your environment to use a different key than keychain.

**Without master key:** falls back to legacy plain JSON. Restrict permissions: `chmod 600 mcp-orchestrator.secrets.json`.

### Tool routing: gateway vs full

**Default: `proxyMode: "gateway"`** — One route per MCP instead of per tool. Keeps tool count low (3 MCPs → 3 gateway tools + native orchestrator tools).

- Call `spotify__call(tool="getNowPlaying", args={})` or `P__call(tool="create_pieces_memory", args={})`
- Use `list_tools(mcp="spotify")` to discover available tools
- Workflows unchanged — they use `mcp` + `tool` in steps

**Legacy: `proxyMode: "full"`** — Every MCP tool as its own proxy (`spotify__getNowPlaying`, `Pieces__create_pieces_memory`, etc.). Full ergonomics but can exceed 80-tool limits with many MCPs. Use `proxyPrefix`, `toolsInclude`, or `toolsExclude` per MCP to trim.

## Workflows

Workflows chain steps. Use placeholders to inject previous step output into the next step's args:

| Placeholder | Use case |
|-------------|----------|
| `{{step0}}` | Full text output of step 0 |
| `{{step1.id}}` | JSON path – when the step returns valid JSON, extract `id` |
| `{{step1:regex:Playlist ID: (\w+)}}` | Regex – single capture group |
| `{{step0:regexAll:ID: (\w+)}}` | Regex all – all captures as **array** |
| `{{now}}` | Current time in ISO format |
| `{{isoDate}}` | Today's date (YYYY-MM-DD) |
| `{{date}}` | Local date string |
| `{{timestamp}}` | Unix milliseconds |
| `{{uuid}}` | Random UUID |
| `{{year}}`, `{{month}}`, `{{day}}`, `{{weekday}}` | Date parts |
| `{{js: new Date().toLocaleDateString('en-US', {month:'long'}) }}` | Arbitrary JavaScript expression |

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
bash <(curl -sSL https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.sh)
```

**Skip auto-start:**
```bash
bash <(curl -sSL https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.sh) --no-startup
```

**Windows PowerShell:**
```powershell
irm https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.ps1 | iex
```

**Windows, skip auto-start:** `$env:NO_STARTUP=1; irm https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.ps1 | iex`

The bootstrap clones the repo to `~/mcp-orchestrator`, runs `npm install` and `npm run build`, then starts the server. It will prompt for optional tools (uv, cloudflared) and encrypted secrets setup.

**Non-interactive** (CI, automation, skip all prompts): `curl -sSL https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.sh | bash`

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

**uv** (for Python MCPs from Discover, e.g. fast-mcp-telegram): The installer prompts to install uv. To skip the prompt:

```bash
./scripts/install.sh --uv     # Install uv
./scripts/install.sh --no-uv  # Skip (default when non-interactive)
```

```powershell
.\scripts\install.ps1 -Uv     # Install uv
.\scripts\install.ps1 -NoUv   # Skip
```

**Control scripts:**
- `./scripts/start.sh` / `.\scripts\start.ps1` — start server in background
- `./scripts/stop.sh` / `.\scripts\stop.ps1` — stop server
- `./scripts/update.sh` / `.\scripts\update.ps1` — update (git pull, npm install, build, restart)
- `./scripts/enable-startup.sh` / `.\scripts\enable-startup.ps1` — enable auto-start on login
- `./scripts/disable-startup.sh` / `.\scripts\disable-startup.ps1` — disable auto-start on login
- Logs: `tail -f .mcp-orchestrator.log` (Mac/Linux) or `Get-Content .mcp-orchestrator.log -Wait -Tail 20` (Windows). On Windows, stderr goes to `.mcp-orchestrator.err`.

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
- **Connect** — Add MCP Orchestrator to Cursor, Claude Desktop, Windsurf, or Continue via Easy Install 
- **Build workflows** by chaining actions from your MCPs; use `{{step0}}`, `{{step1}}`, `{{now}}`, `{{isoDate}}`, etc. in args
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

## Connect (MCP Client Setup)

The **Connect** tab in the Web UI makes it easy to add MCP Orchestrator to your AI client.

1. Open the UI (`npm run ui`) → **Connect** tab
2. Select your **platform** (macOS, Windows, Linux — auto-detected)
3. Select your **client** (Cursor, Claude Desktop, Windsurf, Continue)
4. Click **Easy Install** to write the config into the correct file while keeping your existing MCPs

Or use **Copy config** to paste the JSON manually. Restart your client after saving.

| Client | Config path (macOS) |
|--------|---------------------|
| Cursor | `~/.cursor/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Continue | `~/.continue/config.json` |

**Claude Desktop note:** Claude only supports stdio MCPs, not HTTP. Easy Install uses the built-in stdio bridge (`mcp-bridge.js`) so Claude can talk to the orchestrator’s HTTP endpoint. Ensure MCP Orchestrator is running before opening Claude.

**Run from the mcp-orchestrator directory** when using Easy Install so the bridge path resolves correctly (e.g. `cd mcp-orchestrator && npm run ui`).

## Use as an MCP

The MCP Orchestrator is a first-class MCP server. Add it to any MCP client (Cursor, Claude Desktop, Windsurf, Continue, MCP Inspector, or custom apps) and operate workflows, MCPs, the tunnel, and installs—all from chat, no web UI required.

### Resources (read these for context)
- `orchestrator://glossary` — Read first: reference for every tool, args, usage, examples (customize via `docs/glossary.md`)
- `orchestrator://workflow-guide` — Instruction set for creating workflows: manual run, output inspection, placeholders (see `docs/creating-workflows.md`)
- `orchestrator://config` — Full config (mcps, workflows)
- `orchestrator://status` — MCP health + tunnel status
- `orchestrator://logs` — Recent logs

### Tools by category

| Category | Tools |
|----------|-------|
| **Workflows** | `list_workflows`, `run_workflow`, `get_workflow`, `add_workflow`, `update_workflow`, `delete_workflow`, `schedule_workflow`, `unschedule_workflow` |
| **MCPs** | `list_mcps`, `get_mcp_status`, `add_mcp`, `remove_mcp`, `enable_mcp`, `disable_mcp`, `call_tool`, `list_tools` |
| **Tunnel** | `get_tunnel_status`, `start_tunnel`, `stop_tunnel`, `set_tunnel_domain`, `cloudflare_login`, `generate_tunnel_token`, `revoke_tunnel_token` |
| **Registry** | `search_registry`, `install_from_registry`, `install_npm_mcp` |
| **Observability** | `get_config`, `get_logs`, `clear_logs` |

**Direct MCP access:** Each MCP's tools are exposed as `mcpName__toolName` (e.g. `spotify__getNowPlaying`, `pieces__create_pieces_memory`). Call them directly—no workflow required. Use `call_tool` when you need to specify mcp/tool explicitly.

### Setup

Add the orchestrator as a **Streamable HTTP** MCP with URL `http://localhost:3847/mcp` (or `http://mcporch.local:3847/mcp` if using the hosts entry). **Easiest:** use the Connect tab → Easy Install.

**Cursor, Windsurf, Continue:** These clients support HTTP MCPs. Add URL `http://localhost:3847/mcp` in your client’s MCP settings, or use Connect → Easy Install.

**Claude Desktop:** Claude only supports stdio MCPs. Use Connect → Easy Install (it adds a stdio bridge config), or add manually to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-orchestrator": {
      "command": "node",
      "args": ["/path/to/mcp-orchestrator/build/mcp-bridge.js"],
      "env": {
        "MCP_ORCHESTRATOR_URI": "http://localhost:3847/mcp"
      }
    }
  }
}
```

Replace `/path/to/mcp-orchestrator` with your install path. Ensure the MCP Orchestrator server is running (`npm run ui` or via the install scripts) before connecting.

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

**Example (any MCP client):**
```
URL: https://your-tunnel.trycloudflare.com/tunnel/pieces
Authorization: Bearer <your-token>
```

**Security:**
- MCP tokens in `mcp-orchestrator.secrets.json`. Use **Revoke** to invalidate.
- Tunnel token/URL: use env vars or secrets; never commit.

## Prerequisites

- **Node.js** (v18+)
