# Discover: Python Support & Auth Modal

**Date:** 2025-02-17  
**Status:** Implemented

## Goal

Enable users to install Python/PyPI MCPs from the Discover tab and guide them through auth setup when the MCP requires environment variables (API keys, tokens, etc.).

## Current State

- **Registry**: Official MCP registry at `prod.registry.modelcontextprotocol.io`
- **Discover**: Only supports npm packages (`registryType === 'npm'`); PyPI entries are skipped
- **Install flow**: Click Install → POST `/api/registry/install` → MCP added with no env
- **Auth**: No modal; users must manually add MCP and edit config for env vars
- **Stdio config**: Already supports `env`; connector passes it to spawn; config shape has `env?: Record<string, string>`

## Design

### 1. Backend: PyPI Support

**Location:** `server.ts` (API) and `mcp-server.ts` (tool)

- Detect `registryType === 'pypi'` in packages (in addition to npm)
- For PyPI stdio:
  - **Command:** Prefer `uvx` (if available) → fallback `uv run` → fallback `python -m <module>` or direct CLI
  - **Primary:** `uvx fast-mcp-telegram` — `uvx` runs a PyPI package without installing (like npx for Python)
  - **Fallback:** `uv run fast-mcp-telegram` (pulls and runs)
  - **Last resort:** `pip install fast-mcp-telegram` + `fast-mcp-telegram` (requires pip, two-step)
- Entry point from PyPI: package name becomes CLI (e.g. `fast-mcp-telegram`). Use `identifier` from registry.
- **Args:** From `packageArguments` if present, else `[]`
- **Env:** Accept optional `env` in the install request body; merge into created MCP config

**Runtime detection:** Use whatever is most portable and UX-friendly. Priority: `uvx` (runs without install, like npx) → `uv run` → `pip run` / `pipx` → `pip install` + direct command. Try in order; on first success, use it. If all fail, show clear hint: "Install uv for best experience: https://docs.astral.sh/uv/getting-started/installation"

### 2. Backend: Accept Env in Install

**`POST /api/registry/install`** request body:

```ts
{
  server: { ... },
  env?: Record<string, string>  // e.g. { API_ID: "123", API_HASH: "secret:telegram_hash" }
}
```

- When creating stdio config, add `env: req.body.env` if present
- For values starting with `secret:`, we store in secrets and reference. Options:
  - **A) Store automatically:** If value doesn't start with `secret:` or `env:` and var is `is_secret`, call `setSecret(mcpName + '_' + key, value)` and use `secret:key` in env
  - **B) Pass through:** User passes `secret:existing_key`; we use as-is. For raw values, store in config (simpler but secrets in config file)
  - **Recommendation:** Pass through as-is. Frontend modal offers "Store in Secrets" which PUTs to `/secrets/key` and sends `secret:key` in env. No automatic secret storage from install.

### 3. Backend: Env Resolution for Stdio

**Location:** `connector.ts`

- Before passing `config.env` to StdioClientTransport, resolve each value:
  - `env:VAR_NAME` → `process.env.VAR_NAME`
  - `secret:key` → `getSecret(key)`
  - Otherwise use literal
- Reuse logic from `auth-resolver.ts` or extract a generic `resolveConfigValue(value: string): string | null`.

### 4. Frontend: Auth Modal

**Trigger:** When user clicks Install on a Discover card and the server has `environment_variables` (or `environmentVariables`) with at least one `is_required: true` (or no `is_required` but listed), show auth modal first.

**Modal content:**
- Title: "Configure [MCP Name]"
- Per env var from `environment_variables`:
  - Label: `name` (e.g. API_ID)
  - Description: `description` if present (e.g. "Telegram API ID from my.telegram.org")
  - Input: `type="password"` if `is_secret`, else `type="text"`
  - Optional: "Use secret" — dropdown of existing secret keys, or "Enter value"
- Optional setup steps: If server has `setupInstructions` or we detect known patterns (e.g. fast-mcp-telegram), show collapsible "Before using" section: "Run `fast-mcp-telegram-setup --api-id=...` to authenticate with Telegram"
- Buttons: Cancel | "Install" | "Skip for now" (optional) — if user skips, install anyway with empty env; MCP will fail when started until user adds config via Edit MCP.

**Flow:**
1. User clicks Install
2. Check `server.packages[].environment_variables` for any vars
3. If any vars: show auth modal with form (Install + Skip for now)
4. User either:
   - Fills fields, clicks Install → for `is_secret`: optionally "Store in Secrets" → PUT `/secrets/{key}` → use `secret:key` in env
   - Clicks "Skip for now" → install with empty env (can configure later via Edit MCP)
5. Call `POST /api/registry/install` with `{ server, env?: {...} }`
6. On success: hide modal, refresh, show "Installed"

**Schema mapping:** Registry may use `environment_variables` (snake) or `environmentVariables` (camel). Normalize: `name`, `description`, `is_required`, `is_secret`, `default`, `choices`.

### 5. Frontend: Setup Instructions

- Some MCPs (e.g. fast-mcp-telegram) need a one-time setup: `fast-mcp-telegram-setup --api-id=...`
- Options:
  - **A)** Add `setupInstructions` or `setupCommand` to server.json schema and display in modal
  - **B)** Hardcode known MCPs (e.g. fast-mcp-telegram) with instructions
  - **C)** Link to documentation_url / homepage and say "See setup guide"
- **Decision:** (C) for MVP — show link to docs (documentation_url / homepage_url). (A) if/when registry schema supports `setupInstructions`.

### 6. Backend: install_from_registry Tool

- Mirror the same changes: support PyPI, accept optional `env` in args, merge into config.
- MCP tool won't show a modal (no UI), but the AI can pass `env` when calling the tool if it knows the user has provided credentials.

## Data Flow

```
Discover Card (has env vars)
    → User clicks Install
    → showAuthModal(server)
    → User fills API_ID, API_HASH, etc.
    → Optional: Store secrets via PUT /secrets
    → POST /api/registry/install { server, env }
    → Backend: create MCP (stdio, PyPI) with env
    → Connector resolves env: / secret: at runtime
```

## Edge Cases

- **No uv/pip:** PyPI install fails at runtime. Log clear error: "Install uv: https://docs.astral.sh/uv/getting-started/installation"
- **User skips auth modal:** Allow "Skip for now" / install without filling. MCP gets empty env, will fail when started. User can Edit MCP later to add env. UX-friendly: don't block install.
- **Existing secrets:** Modal can offer "Use existing secret" dropdown populated from `GET /api/secrets/keys` (already exists).

## Scope (MVP)

- [x] Backend: PyPI package detection and stdio config (uvx)
- [x] Backend: Accept env in registry install
- [x] Backend: Resolve env/secret in connector for stdio
- [x] Frontend: Auth modal when server has required env vars
- [x] Frontend: Pass env to install API
- [x] Edit MCP form: env vars JSON field for stdio (so users can configure after Skip)

## Resolved Decisions

| Question | Decision |
|----------|----------|
| uvx vs pip for portability | Try uvx → uv run → pip/pipx in order; use first that works; show install hint on failure |
| Require auth before install? | No — allow "Skip for now"; MCP fails when started; user can Edit MCP later |
| Setup instructions | Link to docs (documentation_url); support setupInstructions from registry if available |

## Out of Scope (Later)

- `setupInstructions` from registry schema (when available, add support)
- "Use existing secret" dropdown in auth modal (GET /api/secrets/keys)
