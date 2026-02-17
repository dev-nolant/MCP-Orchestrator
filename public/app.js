const API = '/api';

let config = { mcps: {}, workflows: [] };
let toolsByMcp = {};
let editingWorkflowIndex = -1;
let mcpStatus = { checking: false, status: {} };

let logStore = [];

async function loadLogs() {
  try {
    const res = await fetch(API + '/logs', { cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => []);
    logStore = Array.isArray(data) ? data : [];
    renderLogsPanel();
    const badge = document.getElementById('logs-badge');
    if (badge) {
      if (!document.getElementById('logs-panel')?.classList.contains('open') && logStore.length > 0) {
        badge.textContent = Math.min(logStore.length, 99);
        badge.classList.remove('hidden');
      } else if (logStore.length === 0) {
        badge.classList.add('hidden');
      }
    }
  } catch {
    logStore = [];
    renderLogsPanel();
  }
}

async function appendLogToServer(type, message, detail = null, output = null) {
  try {
    await api('/logs', {
      method: 'POST',
      body: JSON.stringify({ type, message, detail, output }),
    });
    await loadLogs();
  } catch {
    await loadLogs();
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Generate a JSON template from MCP tool inputSchema (JSON Schema).
 * No LLM needed - deterministic mapping from schema types to empty values.
 */
function schemaToTemplate(inputSchema) {
  if (!inputSchema?.properties || typeof inputSchema.properties !== 'object') return {};
  const obj = {};
  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    if (prop && typeof prop === 'object') {
      if ('default' in prop) obj[key] = prop.default;
      else if (prop.type === 'string') obj[key] = '';
      else if (prop.type === 'number' || prop.type === 'integer') obj[key] = 0;
      else if (prop.type === 'boolean') obj[key] = false;
      else if (prop.type === 'object') obj[key] = {};
      else if (prop.type === 'array') obj[key] = [];
      else obj[key] = '';
    } else {
      obj[key] = '';
    }
  }
  return obj;
}

/**
 * Parse raw MCP errors into pretty { title, message, hint } for display.
 */
function formatMcpError(raw) {
  const s = String(raw || '');
  let jsonRpcMsg = '';
  const jsonMatch = s.match(/\{"jsonrpc"[^}]*"error":\s*\{[^}]*"message":\s*"([^"]+)"/);
  if (jsonMatch) jsonRpcMsg = jsonMatch[1];

  if (
    /401|unauthorized|authentication required|Bearer resource_metadata/i.test(s) ||
    /"message":\s*"Authentication required"/i.test(s) ||
    jsonRpcMsg.toLowerCase().includes('authentication')
  ) {
    return {
      title: 'Authentication required',
      message: jsonRpcMsg || 'This MCP requires a Bearer token or OAuth.',
      hint: 'Add an Authorization header in the MCP config (coming soon).',
    };
  }
  if (
    /timeout|timed out|-32001|ETIMEDOUT/i.test(s) ||
    jsonRpcMsg.toLowerCase().includes('timeout')
  ) {
    return {
      title: 'Request timed out',
      message: jsonRpcMsg || 'The MCP server did not respond in time.',
      hint: 'For URL MCPs, try increasing the request timeout in Edit.',
    };
  }
  if (
    /ECONNREFUSED|connection refused|ENOTFOUND|getaddrinfo/i.test(s) ||
    /connect ECONNREFUSED/i.test(s)
  ) {
    return {
      title: 'Connection failed',
      message: jsonRpcMsg || 'Could not reach the MCP server.',
      hint: 'Check the URL, ensure the server is running, and that no firewall is blocking it.',
    };
  }
  if (/ENOENT|no such file|command not found/i.test(s)) {
    return {
      title: 'Command or file not found',
      message: jsonRpcMsg || s.slice(0, 150),
      hint: 'Verify the command and args in Edit (e.g. npx package name, working directory).',
    };
  }
  if (jsonRpcMsg) {
    return { title: 'MCP error', message: jsonRpcMsg };
  }
  const short = s.length > 200 ? s.slice(0, 200) + '…' : s;
  return { title: 'Error', message: short };
}

function renderPrettyError(parsed) {
  if (!parsed || !parsed.title) return escapeHtml(parsed?.message || 'Unknown error');
  const hint = parsed.hint ? `<div class="mcp-error-hint">${escapeHtml(parsed.hint)}</div>` : '';
  return `<div class="mcp-error-pretty"><span class="mcp-error-icon">⚠</span><div class="mcp-error-content"><div class="mcp-error-title">${escapeHtml(parsed.title)}</div><div class="mcp-error-message">${escapeHtml(parsed.message)}</div>${hint}</div></div>`;
}

function formatStepOutput(text) {
  if (!text || typeof text !== 'string') return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .split('\n')
    .map((line) => {
      const hMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (hMatch) {
        const level = Math.min(hMatch[1].length, 3);
        return `<div class="result-h${level}">${hMatch[2].replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</div>`;
      }
      return line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    })
    .join('<br>');
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const data = res.ok ? await res.json().catch(() => ({})) : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadConfig() {
  config = await api('/config');
  return config;
}

async function saveConfig() {
  await api('/config', { method: 'PUT', body: JSON.stringify(config) });
}

async function loadTools() {
  toolsByMcp = await api('/tools');
  return toolsByMcp;
}

async function checkMcpStatus() {
  if (Object.keys(config.mcps).length === 0) return;
  mcpStatus.checking = true;
  mcpStatus.status = {};
  renderMcpsPanel();
  try {
    mcpStatus.status = await api('/mcp-status');
  } catch (err) {
    mcpStatus.status = {};
  }
  mcpStatus.checking = false;
  renderMcpsPanel();
}

function showModal(content) {
  document.getElementById('modal').innerHTML = content;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function showTokenModal(token, fullUrl, isRegenerate) {
  const title = isRegenerate ? 'New token' : 'Token generated';
  const urlHtml = fullUrl ? `<p class="token-modal-url"><code>${escapeHtml(fullUrl)}</code></p>` : '';
  showModal(`
    <h3>${escapeHtml(title)}</h3>
    <p class="token-modal-warning">Copy it now—it won't be shown again.</p>
    <div class="token-modal-row">
      <input type="text" readonly value="${escapeAttr(token)}" class="token-modal-input" id="token-modal-input" />
      <button type="button" class="btn btn-primary" id="token-modal-copy">Copy</button>
    </div>
    ${urlHtml}
    <div class="modal-actions">
      <button type="button" class="btn btn-primary" onclick="hideModal()">Done</button>
    </div>
  `);
  const input = document.getElementById('token-modal-input');
  const copyBtn = document.getElementById('token-modal-copy');
  input?.select();
  copyBtn?.addEventListener('click', () => {
    navigator.clipboard.writeText(token).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
  });
}

function hideModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

/** Show optional env vars modal for npm install. Some packages (e.g. @iqai/mcp-telegram) need TELEGRAM_BOT_TOKEN. */
function showNpmEnvModal(pkg, onInstall) {
  const hint = /mcp-telegram|telegram/i.test(pkg)
    ? 'Telegram MCPs need TELEGRAM_BOT_TOKEN from @BotFather.'
    : 'Add env vars if this MCP needs API keys or tokens.';
  const content = `
    <h3>Configure env vars (optional)</h3>
    <p class="auth-modal-intro">${escapeHtml(hint)} You can also add these later in Edit MCP → Env vars.</p>
    <div class="form-row">
      <label for="npm-env-json">Env vars (JSON)</label>
      <textarea id="npm-env-json" rows="4" placeholder='{"TELEGRAM_BOT_TOKEN":"your_token_here"}' class="form-textarea"></textarea>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost npm-env-skip">Skip</button>
      <button type="button" class="btn btn-primary npm-env-install">Install</button>
    </div>
  `;
  showModal(content);

  const collectEnv = () => {
    const raw = document.getElementById('npm-env-json')?.value?.trim() || '';
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  document.querySelector('.npm-env-install')?.addEventListener('click', () => {
    const env = collectEnv();
    hideModal();
    onInstall(env);
  });
  document.querySelector('.npm-env-skip')?.addEventListener('click', () => {
    hideModal();
    onInstall({});
  });
}

/** Extract environment_variables from a registry server (npm or pypi package). */
function getEnvVarsFromServer(server) {
  const packages = server?.packages || [];
  for (const pkg of packages) {
    const ev = pkg.environment_variables || pkg.environmentVariables;
    if (Array.isArray(ev) && ev.length) return ev;
  }
  return [];
}

/** Known env vars for packages not in registry. Keys: package name (lowercase, no @) or partial match. */
const KNOWN_ENV_VARS = {
  'iqai/mcp-telegram': [
    { name: 'TELEGRAM_BOT_TOKEN', description: 'Bot token from @BotFather on Telegram', is_required: true, is_secret: true },
  ],
  'mcp-telegram': [
    { name: 'TELEGRAM_BOT_TOKEN', description: 'Bot token from @BotFather on Telegram', is_required: true, is_secret: true },
  ],
  'fast-mcp-telegram': [
    { name: 'API_ID', description: 'From https://my.telegram.org/apps', is_required: true, is_secret: false },
    { name: 'API_HASH', description: 'From https://my.telegram.org/apps', is_required: true, is_secret: true },
  ],
};

function inferEnvVarsFromMcp(mcp) {
  if (!mcp || mcp.type !== 'stdio') return [];
  const args = mcp.args || [];
  const pkg = args.find((a) => typeof a === 'string' && (a.includes('/') || a.includes('mcp-telegram')));
  if (!pkg) return [];
  const norm = pkg.replace(/^@/, '').toLowerCase();
  if (KNOWN_ENV_VARS[norm]) return KNOWN_ENV_VARS[norm];
  for (const [key, vars] of Object.entries(KNOWN_ENV_VARS)) {
    if (norm.includes(key)) return vars;
  }
  if (/telegram/i.test(norm) || /telegram/i.test(mcp.command || '')) {
    return KNOWN_ENV_VARS['mcp-telegram'];
  }
  return [];
}

async function fetchEnvSchemaFromRegistry(mcp) {
  if (!mcp || mcp.type !== 'stdio') return [];
  const args = mcp.args || [];
  const pkg = args.find((a) => typeof a === 'string' && /^@?[\w.-]+\/[\w.-]+$/.test((a || '').replace(/^-y$/, '')));
  if (!pkg) return [];
  const search = pkg.replace(/^@/, '').replace('/', ' ');
  try {
    const data = await api('/registry/servers?search=' + encodeURIComponent(search) + '&limit=5');
    const servers = data.servers || [];
    for (const { server } of servers) {
      const ev = getEnvVarsFromServer(server);
      if (ev.length) return ev;
    }
  } catch (_) {}
  return inferEnvVarsFromMcp(mcp);
}

function syncEnvToHiddenTextarea(container, textarea) {
  const env = {};
  container.querySelectorAll('input[data-env-key]').forEach((el) => {
    const k = el.dataset.envKey;
    const v = el.value?.trim();
    if (k && v) env[k] = v;
  });
  if (textarea) textarea.value = Object.keys(env).length ? JSON.stringify(env, null, 2) : '';
}

async function renderMcpEnvSchema(mcp, mcpName, form) {
  const container = document.getElementById('mcp-env-schema-container');
  if (!container) return;
  const currentEnv = (mcp?.env && typeof mcp.env === 'object') ? mcp.env : {};
  let schema = [];
  try {
    schema = await fetchEnvSchemaFromRegistry(mcp);
  } catch (_) {}

  if (schema.length) {
    container.innerHTML = schema
      .map(
        (v) => {
          const name = v.name || '';
          const desc = v.description || '';
          const isSecret = v.is_secret ?? v.isSecret ?? false;
          const val = currentEnv[name] || '';
          const required = v.is_required ?? v.isRequired ? ' <span class="env-required">required</span>' : '';
          return `
          <div class="auth-modal-field" data-env-key="${escapeAttr(name)}">
            <label for="mcp-env-${escapeAttr(name)}">${escapeHtml(name)}${required}</label>
            ${desc ? `<span class="auth-modal-desc">${escapeHtml(desc)}</span>` : ''}
            <div class="auth-modal-input-row">
              <input type="${isSecret ? 'password' : 'text'}" id="mcp-env-${escapeAttr(name)}" data-env-key="${escapeAttr(name)}" value="${escapeAttr(val)}" placeholder="${isSecret ? 'secret:key or value' : 'value or env:VAR'}" autocomplete="${isSecret ? 'off' : 'on'}" />
              ${isSecret ? '<button type="button" class="btn btn-ghost btn-store-secret-mcp" title="Store in Secrets">Store in Secrets</button>' : ''}
            </div>
          </div>`;
        },
      )
      .join('');
    const hiddenEnv = document.createElement('textarea');
    hiddenEnv.name = 'env';
    hiddenEnv.style.display = 'none';
    hiddenEnv.id = 'mcp-env-json-hidden';
    container.appendChild(hiddenEnv);
    syncEnvToHiddenTextarea(container, hiddenEnv);

    container.querySelectorAll('input[data-env-key]').forEach((el) => {
      el.addEventListener('input', () => syncEnvToHiddenTextarea(container, document.getElementById('mcp-env-json-hidden')));
    });
    container.querySelectorAll('.btn-store-secret-mcp').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const field = btn.closest('.auth-modal-field');
        const input = field?.querySelector('input');
        const name = input?.dataset?.envKey;
        if (!name || !input?.value?.trim()) {
          alert('Enter a value first');
          return;
        }
        const secretKey = `${(mcpName || 'mcp').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')}_${name}`;
        try {
          await api('/secrets/' + encodeURIComponent(secretKey), {
            method: 'PUT',
            body: JSON.stringify({ value: input.value.trim() }),
          });
          input.type = 'text';
          input.value = `secret:${secretKey}`;
          btn.textContent = '✓ Stored';
          btn.classList.add('stored');
          btn.disabled = true;
          syncEnvToHiddenTextarea(container, document.getElementById('mcp-env-json-hidden'));
        } catch (err) {
          alert(err?.message || 'Failed to store secret');
        }
      });
    });
  } else {
    container.innerHTML = `
      <div class="form-row">
        <label>Env vars (JSON)</label>
        <textarea name="env" rows="6" placeholder='{"KEY":"value or secret:key"}' class="form-textarea">${escapeAttr(Object.keys(currentEnv).length ? JSON.stringify(currentEnv, null, 2) : '')}</textarea>
        <div class="form-row-hint">Add env vars as JSON. Use <code>secret:key</code> or <code>env:VAR</code> for sensitive values.</div>
      </div>`;
  }
}

function showAuthModal(server, title, docsUrl, onInstall, onSkip) {
  const envVars = getEnvVarsFromServer(server);
  if (!envVars.length) {
    onInstall({});
    return;
  }

  const docsHtml = docsUrl
    ? `<p class="auth-modal-docs"><a href="${escapeAttr(docsUrl)}" target="_blank" rel="noopener noreferrer">Setup guide</a></p>`
    : '';

  const fieldsHtml = envVars
    .map(
      (v) => {
        const name = v.name || '';
        const desc = v.description || '';
        const isSecret = v.is_secret ?? v.isSecret ?? false;
        const inputType = isSecret ? 'password' : 'text';
        const placeholder = v.default || (isSecret ? 'Enter value or use secret:key' : '');
        return `
        <div class="auth-modal-field" data-name="${escapeAttr(name)}">
          <label for="auth-${escapeAttr(name)}">${escapeHtml(name)}</label>
          ${desc ? `<span class="auth-modal-desc">${escapeHtml(desc)}</span>` : ''}
          <div class="auth-modal-input-row">
            <input type="${inputType}" id="auth-${escapeAttr(name)}" name="${escapeAttr(name)}" placeholder="${escapeAttr(placeholder)}" autocomplete="${isSecret ? 'off' : 'on'}" />
            ${isSecret ? '<button type="button" class="btn btn-ghost btn-store-secret" title="Store value in Secrets">Store in Secrets</button>' : ''}
          </div>
        </div>`;
      },
    )
    .join('');

  const content = `
    <h3>Configure ${escapeHtml(title)}</h3>
    <p class="auth-modal-intro">This MCP needs the following environment variables. You can enter values now or skip and configure later in Edit MCP.</p>
    ${docsHtml}
    <form id="auth-modal-form" class="auth-modal-form">
      ${fieldsHtml}
    </form>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost auth-modal-skip">Skip for now</button>
      <button type="button" class="btn btn-primary auth-modal-install">Install</button>
    </div>
  `;
  showModal(content);

  const form = document.getElementById('auth-modal-form');
  const collectEnv = () => {
    const env = {};
    form.querySelectorAll('input[name]').forEach((el) => {
      const v = el.value?.trim();
      if (v) env[el.name] = v;
    });
    return env;
  };

  form.querySelectorAll('.btn-store-secret').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const field = btn.closest('.auth-modal-field');
      const input = field?.querySelector('input');
      const name = input?.name || input?.id?.replace(/^auth-/, '');
      if (!name || !input?.value?.trim()) {
        alert('Enter a value first');
        return;
      }
      const secretKey = `${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')}_${name}`;
      try {
        await api('/secrets/' + encodeURIComponent(secretKey), {
          method: 'PUT',
          body: JSON.stringify({ value: input.value.trim() }),
        });
        input.type = 'text';
        input.value = `secret:${secretKey}`;
        input.readOnly = true;
        btn.textContent = '✓ Stored';
        btn.classList.add('stored');
        btn.disabled = true;
      } catch (err) {
        alert(err?.message || 'Failed to store secret');
      }
    });
  });

  document.querySelector('.auth-modal-install')?.addEventListener('click', () => {
    const env = collectEnv();
    hideModal();
    onInstall(env);
  });

  document.querySelector('.auth-modal-skip')?.addEventListener('click', () => {
    hideModal();
    onSkip();
  });
}

function showSubdomainEditModal(mcpName, currentSubdomain, baseDomain) {
  const toValid = (s) => (s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'mcp';
  const preview = baseDomain ? `${toValid(currentSubdomain) || 'mcp'}.${baseDomain}` : '';
  showModal(`
    <h3>Edit subdomain for ${escapeHtml(mcpName)}</h3>
    <p class="tunnel-domain-hint">Change the subdomain used for this MCP's public URL. Use lowercase letters, numbers, and hyphens. Leave blank to use MCP name.</p>
    <div class="token-modal-row">
      <label for="subdomain-edit-input">Subdomain</label>
      <input type="text" id="subdomain-edit-input" value="${escapeAttr(currentSubdomain || '')}" placeholder="${escapeAttr(toValid(mcpName))}" class="token-modal-input" />
    </div>
    ${preview ? `<p class="tunnel-domain-hint">Preview: <code>https://<span id="subdomain-preview">${escapeHtml(toValid(currentSubdomain) || toValid(mcpName))}</span>.${escapeHtml(baseDomain)}</code></p>` : ''}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="subdomain-edit-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="subdomain-edit-save">Save</button>
    </div>
  `);
  const input = document.getElementById('subdomain-edit-input');
  const previewEl = document.getElementById('subdomain-preview');
  const updatePreview = () => {
    if (previewEl) previewEl.textContent = toValid(input?.value || '') || toValid(mcpName);
  };
  input?.addEventListener('input', updatePreview);
  input?.focus();
  document.getElementById('subdomain-edit-cancel')?.addEventListener('click', hideModal);
  document.getElementById('subdomain-edit-save')?.addEventListener('click', async () => {
    const raw = input?.value?.trim() || '';
    const value = raw ? raw : null;
    try {
      await api('/mcp/' + encodeURIComponent(mcpName) + '/tunnel-subdomain', {
        method: 'PATCH',
        body: JSON.stringify({ tunnelSubdomain: value }),
      });
      hideModal();
      await renderTunnelPanel();
    } catch (err) {
      alert(err?.message || err?.error || 'Failed to update subdomain');
    }
  });
}

function formatLogTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderLogsPanel() {
  const list = document.getElementById('logs-list');
  const empty = document.getElementById('logs-empty');
  const filter = document.getElementById('logs-filter')?.value || 'all';
  if (!list) return;

  const filtered = filter === 'all' ? logStore : logStore.filter((e) => e.type === filter);
  empty?.classList.toggle('hidden', filtered.length > 0);

  list.innerHTML = filtered
    .map(
      (e) => `
    <div class="log-entry log-entry-clickable" data-log-id="${escapeAttr(e.id)}" data-type="${escapeAttr(e.type)}">
      <div class="log-entry-header">
        <span class="log-type-badge ${e.type} ${(e.type === 'run' || e.type === 'schedule') && !e.success ? 'failed' : ''}">${escapeHtml(e.type)}</span>
        <span class="log-time">${escapeHtml(formatLogTime(e.ts))}</span>
      </div>
      <div class="log-message">${escapeHtml(e.message)}</div>
      ${e.detail ? `<div class="log-detail">${escapeHtml(e.detail)}</div>` : ''}
      <span class="log-expand-hint">Click for details →</span>
    </div>
  `,
    )
    .join('');

  list.querySelectorAll('.log-entry-clickable').forEach((el) => {
    el.addEventListener('click', () => {
      const entry = logStore.find((e) => e.id === el.dataset.logId);
      if (entry) showLogDetailModal(entry);
    });
  });
}

function showLogDetailModal(entry) {
  const fullTime = new Date(entry.ts).toLocaleString();
  let outputHtml = '';
  if (entry.output) {
    const text = Array.isArray(entry.output)
      ? entry.output.map((s, i) => `--- Step ${i + 1} ---\n${s}`).join('\n\n')
      : String(entry.output);
    outputHtml = `<div class="log-detail-output"><pre>${escapeHtml(text)}</pre></div>`;
  }
  const content = `
    <h3>Log Details</h3>
    <div class="log-detail-meta">
      <div><strong>Type</strong> <span class="log-type-badge ${entry.type} ${(entry.type === 'run' || entry.type === 'schedule') && !entry.success ? 'failed' : ''}">${escapeHtml(entry.type)}</span></div>
      <div><strong>Time</strong> ${escapeHtml(fullTime)}</div>
      <div><strong>Status</strong> ${entry.success !== false ? '<span style="color:var(--success)">Success</span>' : '<span style="color:var(--error)">Failed</span>'}</div>
    </div>
    <div class="log-detail-message"><strong>Message</strong><br>${escapeHtml(entry.message)}</div>
    ${entry.detail ? `<div class="log-detail-detail"><strong>Detail</strong><br>${escapeHtml(entry.detail)}</div>` : ''}
    ${outputHtml}
    <div class="log-detail-actions">
      <button type="button" class="btn btn-primary btn-log-detail-close">Close</button>
    </div>
  `;
  showModal(content);
  document.querySelector('.btn-log-detail-close')?.addEventListener('click', hideModal);
}

function showLogsPanel() {
  document.getElementById('logs-panel')?.classList.add('open');
  document.getElementById('logs-overlay')?.classList.remove('hidden');
  document.getElementById('logs-badge')?.classList.add('hidden');
  document.body.style.overflow = 'hidden';
  loadLogs(); // refresh to include any scheduled runs
}

function hideLogsPanel() {
  document.getElementById('logs-panel')?.classList.remove('open');
  document.getElementById('logs-overlay')?.classList.add('hidden');
  document.body.style.overflow = '';
}

const TAB_STORAGE_KEY = 'mcp-orchestrator-tab';
const MCP_SUB_STORAGE_KEY = 'mcp-orchestrator-mcp-sub';
const MCP_VIEW_KEY = 'mcp-orchestrator-mcp-view';
const VALID_TABS = ['mcps', 'workflows', 'schedule', 'run', 'tunnel', 'connect', 'settings'];

function activateMainTab(tabId) {
  const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (!tab && tabId !== 'settings') return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.getElementById('settings-btn')?.classList.toggle('active', tabId === 'settings');
  if (tab) tab.classList.add('active');
  document.getElementById('panel-' + tabId)?.classList.add('active');
  if (tabId === 'run') renderRunPanel();
  if (tabId === 'schedule') renderSchedulePanel();
  if (tabId === 'mcps') checkMcpStatus();
  if (tabId === 'tunnel') renderTunnelPanel();
  if (tabId === 'connect') renderConnectPanel();
  if (tabId === 'settings') renderSettingsPanel();
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;
      activateMainTab(tabId);
      try {
        localStorage.setItem(TAB_STORAGE_KEY, tabId);
      } catch (_) {}
    });
  });
  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  if (saved && VALID_TABS.includes(saved)) activateMainTab(saved);
}

function getMcpStatusBadge(name, mcp) {
  const tools = toolsByMcp[name] || [];
  const isDisabled = mcp.enabled === false;
  const st = mcpStatus.status[name];
  const isChecking = mcpStatus.checking;
  const isOnline = !isDisabled && st?.online === true;
  const isOffline = !isDisabled && st?.online === false;
  const offlineError = isOffline ? (st.error || 'Connection failed') : '';

  if (isDisabled) {
    return '<span class="mcp-status mcp-status-stopped" title="Stopped (spin up to enable)"><span class="mcp-status-dot"></span> Stopped</span>';
  }
  if (isChecking) {
    return '<span class="mcp-status mcp-status-checking" title="Checking…"><span class="mcp-status-dot pulse"></span> Checking…</span>';
  }
  if (isOnline) {
    return `<span class="mcp-status mcp-status-online" title="Online — ${tools.length} tools"><span class="mcp-status-dot"></span> Online</span>`;
  }
  if (isOffline) {
    return `<span class="mcp-status mcp-status-offline" title="${escapeAttr(offlineError)}"><span class="mcp-status-dot"></span> Offline</span>`;
  }
  return '<span class="mcp-status mcp-status-unknown" title="Click Check status">—</span>';
}

function renderMcpItemCard(name, mcp) {
  const tools = toolsByMcp[name] || [];
  const isDisabled = mcp.enabled === false;
  const statusBadge = getMcpStatusBadge(name, mcp);

  return `
    <div class="mcp-item mcp-item-card ${isDisabled ? 'mcp-item-disabled' : ''}" data-name="${escapeAttr(name)}">
      <div class="mcp-item-card-header">
        <span class="mcp-item-title">${escapeHtml(name)}</span>
        ${statusBadge}
      </div>
      <div class="mcp-item-card-meta">${tools.length} tool${tools.length !== 1 ? 's' : ''}</div>
      <div class="mcp-item-actions mcp-item-card-actions">
        <button type="button" class="btn btn-ghost btn-spin-mcp" title="${isDisabled ? 'Spin up' : 'Spin down'}">${isDisabled ? '▶' : '■'}</button>
        <button type="button" class="btn btn-ghost btn-edit-mcp">Edit</button>
        <button type="button" class="btn btn-danger btn-delete-mcp">Delete</button>
      </div>
    </div>
  `;
}

function renderMcpItem(name, mcp) {
  const isUrl = mcp.type === 'url';
  const meta = isUrl ? mcp.url : `${mcp.command} ${(mcp.args || []).join(' ')}`;
  const tools = toolsByMcp[name] || [];
  const isDisabled = mcp.enabled === false;
  const isOffline = !isDisabled && mcpStatus.status[name]?.online === false;
  const offlineError = isOffline ? (mcpStatus.status[name]?.error || 'Connection failed') : '';
  const statusBadge = getMcpStatusBadge(name, mcp);

  return `
    <div class="mcp-item mcp-item-expanded ${isDisabled ? 'mcp-item-disabled' : ''}" data-name="${escapeAttr(name)}">
      <div class="mcp-item-header">
        <div>
          <div class="mcp-item-title-row">
            <span class="mcp-item-title">${escapeHtml(name)}</span>
            ${statusBadge}
            ${mcp.startOnStartup ? '<span class="mcp-startup-badge" title="Starts when orchestrator server starts">↑ startup</span>' : ''}
          </div>
          <div class="mcp-item-meta">${escapeHtml(meta)}</div>
          ${isOffline ? `<div class="mcp-offline-notice">${renderPrettyError(formatMcpError(offlineError))}</div>` : ''}
        </div>
        <div class="mcp-item-actions">
          <button type="button" class="btn btn-ghost btn-spin-mcp" title="${isDisabled ? 'Spin up' : 'Spin down'}">${isDisabled ? '▶ Spin up' : '■ Spin down'}</button>
          <button type="button" class="btn btn-ghost btn-edit-mcp">Edit</button>
          <button type="button" class="btn btn-danger btn-delete-mcp">Delete</button>
        </div>
      </div>
      ${tools.length > 0 ? `
        <div class="steps-builder">
          <strong style="font-size:0.85rem;color:var(--text-muted)">${tools.length} tools</strong>
          <div style="margin-top:0.5rem">
            ${tools.slice(0, 5).map((t) => `
              <div class="tool-item">
                <span class="name">${escapeHtml(t.name)}</span>
                ${t.description ? `<br><span>${escapeHtml(t.description.slice(0, 80))}${t.description.length > 80 ? '…' : ''}</span>` : ''}
              </div>
            `).join('')}
            ${tools.length > 5 ? `<div class="tool-item" style="color:var(--text-muted)">+ ${tools.length - 5} more</div>` : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function getMcpViewMode() {
  try {
    const saved = localStorage.getItem(MCP_VIEW_KEY);
    return saved === 'expanded' ? 'expanded' : 'card';
  } catch {
    return 'card';
  }
}

let mcpWikiOpenFor = null;
let mcpWikiSearchQuery = '';
let mcpWikiActiveTab = 'overview';

function showMcpWiki(name) {
  mcpWikiOpenFor = name;
  mcpWikiSearchQuery = '';
  mcpWikiActiveTab = 'overview';
  document.getElementById('mcp-wiki-modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderMcpWiki(name);
}

function hideMcpWiki() {
  mcpWikiOpenFor = null;
  document.getElementById('mcp-wiki-modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

function getWorkflowsUsingMcp(mcpName) {
  return config.workflows.filter((w) =>
    w.steps?.some((s) => (s.mcp || '').toLowerCase() === (mcpName || '').toLowerCase())
  );
}

function renderMcpWiki(name) {
  const mcp = config.mcps[name];
  if (!mcp) return;
  const tools = toolsByMcp[name] || [];
  const workflows = getWorkflowsUsingMcp(name);
  const scheduled = workflows.filter((w) => w.trigger === 'schedule' && w.schedule?.trim());
  const manual = workflows.filter((w) => w.trigger !== 'schedule' || !w.schedule?.trim());

  const q = (mcpWikiSearchQuery || '').toLowerCase().trim();
  const filteredTools = q
    ? tools.filter(
        (t) =>
          (t.name || '').toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q)
      )
    : tools;

  const isUrl = mcp.type === 'url';
  const meta = isUrl ? mcp.url : `${mcp.command} ${(mcp.args || []).join(' ')}`;
  const isDisabled = mcp.enabled === false;

  document.getElementById('mcp-wiki-modal-title').textContent = name;
  document.getElementById('mcp-wiki-modal-status').innerHTML = getMcpStatusBadge(name, mcp);

  const spinBtn = document.querySelector('.btn-wiki-spin');
  if (spinBtn) {
    spinBtn.textContent = isDisabled ? '▶ Spin up' : '■ Spin down';
    spinBtn.title = isDisabled ? 'Spin up' : 'Spin down';
  }

  // Overview pane
  const overviewHtml = `
    <div class="wiki-overview-grid">
      <div class="wiki-overview-card">
        <div class="wiki-overview-label">Type</div>
        <div class="wiki-overview-value">${isUrl ? 'URL' : 'Stdio'}</div>
      </div>
      <div class="wiki-overview-card">
        <div class="wiki-overview-label">Tools</div>
        <div class="wiki-overview-value">${tools.length}</div>
      </div>
      <div class="wiki-overview-card">
        <div class="wiki-overview-label">Workflows</div>
        <div class="wiki-overview-value">${workflows.length}</div>
      </div>
      <div class="wiki-overview-card wiki-overview-card-wide">
        <div class="wiki-overview-label">Connection</div>
        <div class="wiki-overview-value"><code>${escapeHtml(meta)}</code></div>
      </div>
    </div>
  `;
  document.getElementById('wiki-pane-overview').innerHTML = overviewHtml;

  // Tools pane
  let toolsHtml = '';
  if (filteredTools.length === 0) {
    toolsHtml = `<p class="mcp-wiki-empty">${q ? 'No tools match your search.' : 'No tools loaded. Spin up the MCP and click Check status.'}</p>`;
  } else {
    toolsHtml = filteredTools
      .map(
        (t) => `
      <div class="mcp-wiki-tool-card" data-tool-name="${escapeAttr(t.name)}">
        <div class="mcp-wiki-tool-card-header">
          <span class="mcp-wiki-tool-name">${escapeHtml(t.name)}</span>
          <span class="mcp-wiki-tool-expand">▼</span>
        </div>
        ${t.description ? `<div class="mcp-wiki-tool-desc">${escapeHtml(t.description.slice(0, 150))}${(t.description || '').length > 150 ? '…' : ''}</div>` : ''}
        <div class="mcp-wiki-tool-schema-wrap hidden" data-schema-wrap>
          <div class="mcp-wiki-tool-schema-row">
            <pre class="mcp-wiki-tool-schema" data-schema></pre>
            <button type="button" class="btn btn-ghost btn-copy-schema" title="Copy schema">Copy</button>
          </div>
        </div>
      </div>
    `
      )
      .join('');
  }
  const toolsPane = document.getElementById('wiki-pane-tools');
  const existingSearch = toolsPane.querySelector('#mcp-wiki-search');
  if (!existingSearch) {
    toolsPane.innerHTML = `
      <div class="wiki-tools-search-wrap">
        <input type="search" id="mcp-wiki-search" placeholder="Search tools…" class="mcp-wiki-search" value="${escapeAttr(mcpWikiSearchQuery)}" autocomplete="off" />
      </div>
      <div id="mcp-wiki-tools-list" class="mcp-wiki-tools-list">${toolsHtml}</div>
    `;
    toolsPane.querySelector('#mcp-wiki-search')?.addEventListener('input', () => {
      mcpWikiSearchQuery = document.getElementById('mcp-wiki-search')?.value || '';
      renderMcpWiki(name);
    });
  } else {
    const listEl = document.getElementById('mcp-wiki-tools-list');
    if (listEl) listEl.innerHTML = toolsHtml;
  }

  // Implementations pane
  const workflowToHtml = (w) => {
    const idx = config.workflows.indexOf(w);
    const isSched = w.trigger === 'schedule' && w.schedule?.trim();
    const steps = (w.steps || [])
      .filter((s) => (s.mcp || '').toLowerCase() === (name || '').toLowerCase())
      .map((s) => s.tool)
      .join(', ');
    return `
      <div class="mcp-wiki-impl-card wiki-impl-workflow" data-index="${idx}">
        <div class="mcp-wiki-impl-card-body">
          <span class="mcp-wiki-impl-name">${escapeHtml(w.name)}</span>
          ${steps ? `<span class="mcp-wiki-impl-meta">${escapeHtml(steps)}</span>` : ''}
        </div>
        ${isSched ? `<span class="mcp-wiki-impl-badge">${escapeHtml(w.schedule || '')}</span>` : '<span class="mcp-wiki-impl-badge mcp-wiki-impl-badge-manual">Manual</span>'}
      </div>
    `;
  };
  let implHtml = '';
  if (workflows.length === 0) {
    implHtml = '<p class="mcp-wiki-empty">No workflows use this MCP yet. Add one in the Workflows tab.</p>';
  } else {
    implHtml =
      (scheduled.length > 0
        ? `<h4 class="wiki-pane-subtitle">Scheduled</h4><div class="mcp-wiki-impl-list">${scheduled.map(workflowToHtml).join('')}</div>`
        : '') +
      (manual.length > 0
        ? `<h4 class="wiki-pane-subtitle">Manual</h4><div class="mcp-wiki-impl-list">${manual.map(workflowToHtml).join('')}</div>`
        : '');
  }
  document.getElementById('wiki-pane-implementations').innerHTML = implHtml;

  // Tab switching
  document.querySelectorAll('.mcp-wiki-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === mcpWikiActiveTab);
  });
  document.querySelectorAll('.mcp-wiki-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pane === mcpWikiActiveTab);
  });

  // Tool expand + copy
  document.querySelectorAll('.mcp-wiki-tool-card').forEach((el) => {
    const schemaWrap = el.querySelector('[data-schema-wrap]');
    const schemaEl = el.querySelector('[data-schema]');
    const expandIcon = el.querySelector('.mcp-wiki-tool-expand');
    el.querySelector('.mcp-wiki-tool-card-header')?.addEventListener('click', () => {
      if (!schemaWrap || !schemaEl) return;
      if (schemaWrap.classList.contains('hidden')) {
        const tool = tools.find((t) => t.name === el.dataset.toolName);
        if (tool?.inputSchema) {
          schemaEl.textContent = JSON.stringify(tool.inputSchema, null, 2);
        } else {
          schemaEl.textContent = '(no schema)';
        }
        schemaWrap.classList.remove('hidden');
        if (expandIcon) expandIcon.textContent = '▲';
      } else {
        schemaWrap.classList.add('hidden');
        if (expandIcon) expandIcon.textContent = '▼';
      }
    });
    el.querySelector('.btn-copy-schema')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = schemaEl?.textContent || '';
      if (text && text !== '(no schema)') {
        navigator.clipboard?.writeText(text).then(() => {
          const btn = e.target;
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = orig), 1200);
        });
      }
    });
  });

  document.querySelectorAll('.wiki-impl-workflow').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index, 10);
      if (isNaN(idx)) return;
      editingWorkflowIndex = idx;
      hideMcpWiki();
      activateMainTab('workflows');
      showWorkflowModal();
    });
  });

}

function initMcpWiki() {
  document.querySelector('.mcp-wiki-close')?.addEventListener('click', hideMcpWiki);
  document.getElementById('mcp-wiki-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'mcp-wiki-modal-overlay') hideMcpWiki();
  });
  document.getElementById('mcp-wiki-modal')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.btn-wiki-edit')) {
      e.preventDefault();
      const nameToEdit = mcpWikiOpenFor;
      if (nameToEdit) {
        hideMcpWiki();
        showMcpModal(nameToEdit);
      }
    }
    if (e.target.closest('.btn-wiki-spin')) {
      e.preventDefault();
      if (!mcpWikiOpenFor) return;
      const mcp = config.mcps[mcpWikiOpenFor];
      if (!mcp) return;
      const isDisabled = mcp.enabled === false;
      api(`/mcp/${encodeURIComponent(mcpWikiOpenFor)}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: isDisabled }),
      })
        .then(async () => {
          mcp.enabled = isDisabled;
          await loadConfig();
          await loadTools();
          checkMcpStatus();
          renderMcpWiki(mcpWikiOpenFor);
          renderMcpsPanel();
        })
        .catch((err) => alert(err.message || 'Failed'));
    }
  });

  document.querySelectorAll('.mcp-wiki-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      mcpWikiActiveTab = tab.dataset.tab;
      document.querySelectorAll('.mcp-wiki-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === mcpWikiActiveTab));
      document.querySelectorAll('.mcp-wiki-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === mcpWikiActiveTab));
    });
  });
}

function renderMcpsPanel() {
  const list = document.getElementById('mcps-list');
  const banner = document.getElementById('mcp-checking-banner');
  if (banner) banner.classList.toggle('hidden', !mcpStatus.checking);

  const viewMode = getMcpViewMode();
  list.classList.toggle('mcps-card-view', viewMode === 'card');
  list.classList.toggle('mcps-expanded-view', viewMode === 'expanded');

  document.querySelectorAll('.mcp-view-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewMode);
  });

  const entries = Object.entries(config.mcps);
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">No MCPs yet. Add one by URL or file (stdio).</div>';
    return;
  }
  const renderFn = viewMode === 'card' ? renderMcpItemCard : renderMcpItem;
  list.innerHTML = entries.map(([name, mcp]) => renderFn(name, mcp)).join('');

  list.querySelectorAll('.mcp-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.mcp-item-actions')) return;
      const name = item.dataset.name;
      if (name) showMcpWiki(name);
    });
  });

  list.querySelectorAll('.btn-edit-mcp').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.closest('.mcp-item').dataset.name;
      showMcpModal(name);
    });
  });
  list.querySelectorAll('.btn-delete-mcp').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.closest('.mcp-item').dataset.name;
      if (!confirm(`Delete MCP "${name}"?`)) return;
      delete config.mcps[name];
      await saveConfig();
      await loadTools();
      renderMcpsPanel();
      await appendLogToServer('config', `Deleted MCP "${name}"`);
    });
  });
  list.querySelectorAll('.btn-spin-mcp').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.closest('.mcp-item').dataset.name;
      const mcp = config.mcps[name];
      if (!mcp) return;
      const nextEnabled = mcp.enabled !== false;
      const action = nextEnabled ? 'Spin down' : 'Spin up';
      try {
        await api(`/mcp/${encodeURIComponent(name)}/enabled`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !nextEnabled }),
        });
        mcp.enabled = !nextEnabled;
        await loadConfig();
        await loadTools();
        renderMcpsPanel();
        checkMcpStatus();
        await loadLogs();
      } catch (err) {
        await appendLogToServer('spin', `${action} ${name} failed`, err.message);
        alert(err.message || 'Failed to update');
      }
    });
  });
}

let discoverCursor = null;
let discoverSearchQuery = '';

/** Normalize npm package or plain search for registry API. */
function normalizeDiscoverSearch(q) {
  const s = (q || '').trim();
  if (!s) return '';
  if (/^@?[\w.-]+\/[\w.-]+$/.test(s.replace(/^@/, ''))) {
    return s.replace(/^@/, '').replace('/', ' ');
  }
  return s;
}

async function loadDiscoverServers(search = '', append = false) {
  const loadingEl = document.getElementById('discover-loading');
  const cardsEl = document.getElementById('discover-cards');
  const emptyEl = document.getElementById('discover-empty');
  loadingEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  if (!append) cardsEl.innerHTML = '';

  const trimmed = (search || '').trim();
  const looksLikeNpm = trimmed && /^@?[\w.-]+\/[\w.-]+$/.test(trimmed.replace(/^@/, ''));
  if (looksLikeNpm) {
    const npmCard = document.createElement('div');
    npmCard.className = 'discover-card discover-npm-card';
    const pkg = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    npmCard.innerHTML = `
      <div class="discover-card-icon discover-npm-icon">📦</div>
      <div class="discover-card-body">
        <h4 class="discover-card-title">Install from npm</h4>
        <p class="discover-card-desc"><code>${escapeHtml(pkg)}</code></p>
      </div>
      <div class="discover-card-actions">
        <button type="button" class="btn btn-primary btn-install-npm">Install</button>
      </div>
    `;
    npmCard.querySelector('.btn-install-npm').addEventListener('click', async () => {
      const btn = npmCard.querySelector('.btn-install-npm');
      const doInstall = async (env = {}) => {
        btn.disabled = true;
        btn.textContent = 'Installing…';
        try {
          const body = { package: pkg };
          if (Object.keys(env).length) body.env = env;
          const { name: installedName } = await api('/install-npm', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          await loadConfig();
          await loadTools();
          renderMcpsPanel();
          checkMcpStatus();
          btn.textContent = 'Installed';
          await loadLogs();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Install';
          await appendLogToServer('install', `Install failed: ${pkg}`, err.message);
          alert(err.message || 'Install failed');
        }
      };
      showNpmEnvModal(pkg, doInstall);
    });
    cardsEl.insertBefore(npmCard, cardsEl.firstChild);
  }

  try {
    const registrySearch = normalizeDiscoverSearch(search);
    const params = new URLSearchParams();
    params.set('limit', '20');
    if (registrySearch) params.set('search', registrySearch);
    if (append && discoverCursor) params.set('cursor', discoverCursor);
    const data = await api('/registry/servers?' + params.toString());
    discoverCursor = data.metadata?.nextCursor || null;

    const servers = data.servers || [];
    const installedNames = new Set(Object.keys(config.mcps).map((k) => k.toLowerCase()));

    servers.forEach(({ server }) => {
      const title = server.title || server.name.split('/').pop() || server.name;
      const desc = server.description || '';
      const icon = server.icons?.[0]?.src || '';
      const installed = installedNames.has(title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '').toLowerCase());

      const card = document.createElement('div');
      card.className = 'discover-card';
      card.dataset.server = JSON.stringify({ server });
      card.innerHTML = `
        <div class="discover-card-icon">
          ${icon ? `<img src="${escapeAttr(icon)}" alt="" onerror="this.style.display='none'">` : '<div class="discover-card-icon-placeholder">' + escapeHtml(title.slice(0, 2).toUpperCase()) + '</div>'}
        </div>
        <div class="discover-card-body">
          <h4 class="discover-card-title">${escapeHtml(title)}</h4>
          <p class="discover-card-desc">${escapeHtml(desc.slice(0, 120))}${desc.length > 120 ? '…' : ''}</p>
        </div>
        <div class="discover-card-actions">
          <button type="button" class="btn btn-primary btn-install-mcp" ${installed ? 'disabled' : ''}>${installed ? 'Installed' : 'Install'}</button>
        </div>
      `;

      if (!installed) {
        card.querySelector('.btn-install-mcp').addEventListener('click', async () => {
          const btn = card.querySelector('.btn-install-mcp');
          const payload = JSON.parse(card.dataset.server);
          const server = payload.server;
          const envVars = getEnvVarsFromServer(server);
          const docsUrl = server?.documentation_url || server?.homepage_url || server?.website_url || '';

          const doInstall = async (env = {}) => {
            btn.disabled = true;
            btn.textContent = 'Installing…';
            try {
              const body = envVars.length && Object.keys(env).length ? { ...payload, env } : payload;
              const { name: installedName } = await api('/registry/install', { method: 'POST', body: JSON.stringify(body) });
              await loadConfig();
              await loadTools();
              renderMcpsPanel();
              checkMcpStatus();
              btn.textContent = 'Installed';
              await loadLogs();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = 'Install';
              await appendLogToServer('install', `Registry install failed: ${title}`, err.message);
              alert(err.message || 'Install failed');
            }
          };

          if (envVars.length) {
            showAuthModal(server, title, docsUrl, doInstall, () => doInstall({}));
          } else {
            await doInstall();
          }
        });
      }

      cardsEl.appendChild(card);
    });

    if (!append && servers.length === 0) emptyEl.classList.remove('hidden');
    document.getElementById('discover-load-more').style.display = discoverCursor ? 'inline-flex' : 'none';
  } catch (err) {
    cardsEl.innerHTML = `<div class="discover-error">${escapeHtml(String(err.message))}</div>`;
  } finally {
    loadingEl.classList.add('hidden');
  }
}

function renderDiscoverPanel() {
  const sub = document.querySelector('.mcp-sub-tab[data-mcp-sub="discover"]');
  if (sub?.classList.contains('active')) {
    loadDiscoverServers(discoverSearchQuery, false);
  }
}

const VALID_MCP_SUBS = ['my-mcps', 'discover'];

function activateMcpSubTab(subId) {
  const tab = document.querySelector(`.mcp-sub-tab[data-mcp-sub="${subId}"]`);
  if (!tab) return;
  document.querySelectorAll('.mcp-sub-tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.mcp-sub-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('mcp-sub-panel-' + subId)?.classList.add('active');
  if (subId === 'discover') renderDiscoverPanel();
}

function initMcpViewToggle() {
  document.querySelectorAll('.mcp-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (!view) return;
      try {
        localStorage.setItem(MCP_VIEW_KEY, view);
      } catch (_) {}
      renderMcpsPanel();
    });
  });
}

function initMcpSubTabs() {
  document.querySelectorAll('.mcp-sub-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const subId = tab.dataset.mcpSub;
      activateMcpSubTab(subId);
      try {
        localStorage.setItem(MCP_SUB_STORAGE_KEY, subId);
      } catch (_) {}
    });
  });
  const saved = localStorage.getItem(MCP_SUB_STORAGE_KEY);
  if (saved && VALID_MCP_SUBS.includes(saved)) activateMcpSubTab(saved);

  const searchInput = document.getElementById('discover-search');
  let searchTimeout;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      discoverSearchQuery = searchInput.value.trim();
      discoverCursor = null;
      renderDiscoverPanel();
    }, 300);
  });

  document.getElementById('discover-load-more')?.addEventListener('click', () => {
    loadDiscoverServers(discoverSearchQuery, true);
  });
}

async function renderTunnelPanel() {
  const mcpsListEl = document.getElementById('tunnel-mcps-list');
  const secureStatusEl = document.getElementById('tunnel-secure-status');
  const secureUrlEl = document.getElementById('tunnel-secure-url');
  const startBtn = document.getElementById('tunnel-start-btn');
  const stopBtn = document.getElementById('tunnel-stop-btn');
  const namedHint = document.getElementById('tunnel-named-hint');
  if (!mcpsListEl) return;

  try {
    const status = await api('/tunnel/status');
    const secure = status.secure;
    const securePersisted = status.securePersisted;
    const tokenMcps = status.tokenMcps || [];
    const baseUrl = secure?.url || securePersisted?.url;
    const mcps = Object.keys(config.mcps);

    if (namedHint) namedHint.classList.toggle('hidden', !status.isNamedConfigured);

    const loginStatus = document.getElementById('tunnel-cloudflare-status');
    const loginBtn = document.getElementById('tunnel-cloudflare-login-btn');
    if (loginStatus && loginBtn) {
      if (status.isCloudflareLoggedIn) {
        loginStatus.textContent = 'Cloudflare: logged in';
        loginStatus.classList.add('tunnel-logged-in');
        loginBtn.textContent = 'Re-login';
      } else {
        loginStatus.textContent = '';
        loginStatus.classList.remove('tunnel-logged-in');
        loginBtn.textContent = 'Login to Cloudflare';
      }
    }

    const domainRow = document.getElementById('tunnel-domain-row');
    const domainInput = document.getElementById('tunnel-domain-input');
    if (domainRow && domainInput) {
      domainRow.classList.toggle('hidden', !status.isCloudflareLoggedIn);
      if (status.baseDomain) domainInput.value = status.baseDomain;
    }

    const inactiveNote = document.getElementById('tunnel-inactive-note');
    const hasSubdomainUrls = Object.keys(status.subdomainUrls || {}).length > 0;
    const showBaseUrlBlock = !hasSubdomainUrls && baseUrl;
    if (secure) {
      startBtn?.classList.add('hidden');
      stopBtn?.classList.remove('hidden');
      if (secureStatusEl) {
        secureStatusEl.classList.toggle('hidden', hasSubdomainUrls);
        secureStatusEl.classList.remove('tunnel-inactive');
      }
      if (secureUrlEl) secureUrlEl.textContent = baseUrl || '';
      inactiveNote?.classList.add('hidden');
    } else {
      startBtn?.classList.remove('hidden');
      startBtn && (startBtn.disabled = false);
      startBtn && (startBtn.textContent = 'Start tunnel');
      stopBtn?.classList.add('hidden');
      if (secureStatusEl) {
        secureStatusEl.classList.toggle('hidden', hasSubdomainUrls || !baseUrl);
        secureStatusEl.classList.add('tunnel-inactive');
      }
      if (secureUrlEl) secureUrlEl.textContent = baseUrl || '';
      inactiveNote?.classList.toggle('hidden', !showBaseUrlBlock);
    }

    if (mcps.length === 0) {
      mcpsListEl.innerHTML = '<div class="empty-state">No MCPs configured. Add MCPs in the MCPs tab first.</div>';
      return;
    }

    const subdomainUrls = status.subdomainUrls || {};
    mcpsListEl.innerHTML = mcps
      .map((name) => {
        const mcp = config.mcps[name];
        const typeLabel = mcp?.type === 'url' ? 'URL' : 'stdio';
        const hasToken = tokenMcps.includes(name);
        const fullUrl = subdomainUrls[name] || (baseUrl ? `${baseUrl}/tunnel/${encodeURIComponent(name)}` : null);

        const tunnelSubdomains = status.tunnelSubdomains || {};
        const toSub = (s) => (s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'mcp';
        const currentSub = tunnelSubdomains[name] ?? (fullUrl ? (fullUrl.match(/^https:\/\/([^.]+)\./)?.[1] ?? null) : null) ?? toSub(name);
        const editSubdomainBtn = status.baseDomain ? `<button type="button" class="btn btn-ghost btn-edit-subdomain" data-name="${escapeAttr(name)}" data-sub="${escapeAttr(currentSub)}" title="Edit subdomain">Edit subdomain</button>` : '';

        if (hasToken) {
          return `
            <div class="tunnel-mcp-row tunnel-mcp-active" data-name="${escapeAttr(name)}">
              <div class="tunnel-mcp-info">
                <span class="tunnel-mcp-name">${escapeHtml(name)}</span>
                <span class="tunnel-mcp-type">${escapeHtml(typeLabel)}</span>
              </div>
              <div class="tunnel-mcp-token">
                <span class="tunnel-token-status">Token stored</span>
                ${fullUrl ? `<code class="tunnel-url-code">${escapeHtml(fullUrl)}</code>` : ''}
                <div class="tunnel-mcp-actions">
                  ${editSubdomainBtn}
                  ${fullUrl ? `<button type="button" class="btn btn-ghost btn-copy-tunnel-url" data-url="${escapeAttr(fullUrl)}" title="Copy URL">Copy URL</button>` : ''}
                  <button type="button" class="btn btn-ghost btn-regenerate-token" data-mcp="${escapeAttr(name)}">Regenerate token</button>
                  <button type="button" class="btn btn-ghost btn-revoke-token" data-mcp="${escapeAttr(name)}">Revoke</button>
                </div>
              </div>
            </div>
          `;
        }

        return `
          <div class="tunnel-mcp-row" data-name="${escapeAttr(name)}">
            <div class="tunnel-mcp-info">
              <span class="tunnel-mcp-name">${escapeHtml(name)}</span>
              <span class="tunnel-mcp-type">${escapeHtml(typeLabel)}</span>
            </div>
            <div class="tunnel-mcp-actions">
              ${editSubdomainBtn}
              <button type="button" class="btn btn-primary btn-generate-tunnel-token" data-mcp="${escapeAttr(name)}">Generate token</button>
            </div>
          </div>
        `;
      })
      .join('');

    mcpsListEl.querySelectorAll('.btn-generate-tunnel-token').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Generating…';
        try {
          const data = await api('/tunnel/token/' + encodeURIComponent(btn.dataset.mcp), { method: 'POST' });
          await renderTunnelPanel();
          await loadLogs();
          if (data.token) {
            showTokenModal(data.token, data.fullUrl || null, false);
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Generate token';
          alert(err?.message || err?.error || 'Failed to generate token');
        }
      });
    });

    mcpsListEl.querySelectorAll('.btn-regenerate-token').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Regenerate token? The old token will stop working.')) return;
        try {
          const data = await api('/tunnel/token/' + encodeURIComponent(btn.dataset.mcp), { method: 'POST' });
          await renderTunnelPanel();
          await loadLogs();
          if (data.token) {
            showTokenModal(data.token, data.fullUrl || null, true);
          }
        } catch (err) {
          alert(err?.message || err?.error || 'Failed to regenerate');
        }
      });
    });

    mcpsListEl.querySelectorAll('.btn-revoke-token').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('/tunnel/token/' + encodeURIComponent(btn.dataset.mcp), { method: 'DELETE' });
          await renderTunnelPanel();
          await loadLogs();
        } catch (err) {
          alert(err?.message || err?.error || 'Failed to revoke');
        }
      });
    });

    mcpsListEl.querySelectorAll('.btn-copy-tunnel-url').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url?.trim();
        if (url) {
          navigator.clipboard.writeText(url).then(() => {
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = orig; }, 1500);
          });
        }
      });
    });

    mcpsListEl.querySelectorAll('.btn-edit-subdomain').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        const currentSub = btn.dataset.sub || '';
        const baseDomain = status.baseDomain?.replace(/^\.+/, '') || '';
        showSubdomainEditModal(name, currentSub, baseDomain);
      });
    });
  } catch {
    mcpsListEl.innerHTML = '<div class="empty-state">Failed to load tunnel status.</div>';
  }
}

async function renderConnectPanel() {
  const platformSel = document.getElementById('connect-platform');
  const clientSel = document.getElementById('connect-client');
  const previewEl = document.getElementById('connect-config-preview');
  const statusEl = document.getElementById('connect-status');
  const guideEl = document.getElementById('connect-guide-content');
  if (!platformSel || !clientSel || !previewEl) return;

  const platform = platformSel.value;
  const client = clientSel.value;

  try {
    const data = await api(`/mcp-client/config?platform=${encodeURIComponent(platform)}&client=${encodeURIComponent(client)}`);
    previewEl.textContent = data.configString || JSON.stringify(data.config, null, 2);

    if (guideEl) {
      const guides = {
        cursor: {
          mac: '~/.cursor/mcp.json',
          windows: '%USERPROFILE%\\.cursor\\mcp.json',
          linux: '~/.cursor/mcp.json',
          steps: ['Open Cursor Settings → Features → MCP', 'Or edit the file directly', 'Restart Cursor after saving'],
        },
        'claude-desktop': {
          mac: '~/Library/Application Support/Claude/claude_desktop_config.json',
          windows: '%APPDATA%\\Claude\\claude_desktop_config.json',
          linux: '~/.config/Claude/claude_desktop_config.json',
          steps: ['Claude Desktop uses stdio only—we use a bridge (npx @pyroprompts/mcp-stdio-to-streamable-http-adapter)', 'Restart Claude Desktop completely after saving', 'Ensure MCP Orchestrator is running before opening Claude'],
        },
        windsurf: {
          mac: '~/.codeium/windsurf/mcp_config.json',
          windows: '%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json',
          linux: '~/.codeium/windsurf/mcp_config.json',
          steps: ['Edit mcp_config.json or use Windsurf MCP settings', 'Restart Windsurf after saving'],
        },
        continue: {
          mac: '~/.continue/config.json',
          windows: '%USERPROFILE%\\.continue\\config.json',
          linux: '~/.continue/config.json',
          steps: ['Edit config.json (or config.yaml on older versions)', 'Restart Continue after saving'],
        },
      };
      const g = guides[client] || guides.cursor;
      const pathKey = platform;
      const configPath = g[pathKey] || g.mac;
      guideEl.innerHTML = `
        <p><strong>Config path:</strong> <code>${escapeHtml(configPath)}</code></p>
        <p><strong>Steps:</strong></p>
        <ul>${(g.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      `;
    }
  } catch (err) {
    previewEl.textContent = 'Failed to load config.';
    if (statusEl) {
      statusEl.textContent = err?.message || 'Error';
      statusEl.classList.remove('hidden', 'connect-status-success');
      statusEl.classList.add('connect-status-error');
    }
  }

  if (statusEl) statusEl.classList.add('hidden');
}

function initConnectPanel() {
  const platformSel = document.getElementById('connect-platform');
  const clientSel = document.getElementById('connect-client');
  const installBtn = document.getElementById('connect-install-btn');
  const copyBtn = document.getElementById('connect-copy-btn');
  const statusEl = document.getElementById('connect-status');

  const refresh = () => renderConnectPanel();

  platformSel?.addEventListener('change', refresh);
  clientSel?.addEventListener('change', refresh);

  installBtn?.addEventListener('click', async () => {
    installBtn.disabled = true;
    if (statusEl) {
      statusEl.classList.add('hidden');
      statusEl.textContent = '';
    }
    try {
      const data = await api('/mcp-client/install', {
        method: 'POST',
        body: JSON.stringify({
          platform: platformSel?.value || 'mac',
          client: clientSel?.value || 'cursor',
        }),
      });
      if (statusEl) {
        statusEl.textContent = data.message || 'Installed successfully. Restart your client.';
        statusEl.classList.remove('hidden', 'connect-status-error');
        statusEl.classList.add('connect-status-success');
      }
      await loadLogs();
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err?.message || err?.error || 'Install failed';
        statusEl.classList.remove('hidden', 'connect-status-success');
        statusEl.classList.add('connect-status-error');
      }
    } finally {
      installBtn.disabled = false;
    }
  });

  copyBtn?.addEventListener('click', async () => {
    const preview = document.getElementById('connect-config-preview')?.textContent;
    if (preview) {
      try {
        await navigator.clipboard.writeText(preview);
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      } catch {
        alert('Copy failed');
      }
    }
  });

  (async () => {
    try {
      const { platform } = await api('/mcp-client/platform');
      if (platformSel && platform) {
        platformSel.value = platform;
        refresh();
      }
    } catch {
      refresh();
    }
  })();
}

function initTunnelPanel() {
  const startBtn = document.getElementById('tunnel-start-btn');
  const stopBtn = document.getElementById('tunnel-stop-btn');
  const loginBtn = document.getElementById('tunnel-cloudflare-login-btn');

  const domainSaveBtn = document.getElementById('tunnel-domain-save-btn');
  const domainInput = document.getElementById('tunnel-domain-input');
  domainSaveBtn?.addEventListener('click', async () => {
    const domain = domainInput?.value?.trim();
    if (!domain) {
      alert('Enter a domain (e.g. mcp.example.com)');
      return;
    }
    try {
      await api('/tunnel/domain', { method: 'PUT', body: JSON.stringify({ domain }) });
      await renderTunnelPanel();
    } catch (err) {
      alert(err?.message || err?.error || 'Failed to save domain');
    }
  });

  loginBtn?.addEventListener('click', async () => {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Opening browser…';
    try {
      const result = await api('/tunnel/cloudflare/login', { method: 'POST', body: '{}' });
      await renderTunnelPanel();
      await loadLogs();
      if (result.success) {
        alert(result.message);
      } else {
        alert(result.message || 'Login failed');
      }
    } catch (err) {
      alert(err?.message || err?.error || 'Login failed');
    } finally {
      loginBtn.disabled = false;
    }
  });

  startBtn?.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    try {
      await api('/tunnel/start', { method: 'POST', body: '{}' });
      await renderTunnelPanel();
      await loadLogs();
    } catch (err) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start tunnel';
      alert(err?.message || err?.error || 'Failed to start tunnel. Install cloudflared: Mac: brew install cloudflared; Windows: winget install Cloudflare.cloudflared');
    }
  });

  stopBtn?.addEventListener('click', async () => {
    try {
      await api('/tunnel/stop', { method: 'POST', body: '{}' });
      await renderTunnelPanel();
      await loadLogs();
    } catch (err) {
      alert(err?.message || err?.error || 'Failed to stop');
    }
  });

  document.getElementById('panel-tunnel')?.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.btn-copy-tunnel-url, .btn-copy-secure-url');
    if (!copyBtn) return;
    const url = copyBtn.dataset?.url?.trim() || document.getElementById('tunnel-secure-url')?.textContent?.trim();
    if (url) {
      navigator.clipboard.writeText(url).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      });
    }
  });
}

function showMcpModal(existingName = null) {
  const mcp = existingName ? config.mcps[existingName] : null;
  const isUrl = mcp ? mcp.type === 'url' : true;

  const content = `
    <h3>${existingName ? 'Edit MCP' : 'Add MCP'}</h3>
    <form id="mcp-form">
      <div class="form-row">
        <label>Name</label>
        <input type="text" name="name" value="${escapeAttr(existingName || '')}" placeholder="e.g. spotify" required ${existingName ? 'readonly' : ''} />
      </div>
      <div class="form-row">
        <label>Type</label>
        <div class="type-tabs">
          <button type="button" class="type-tab ${isUrl ? 'active' : ''}" data-type="url">URL</button>
          <button type="button" class="type-tab ${!isUrl ? 'active' : ''}" data-type="stdio">File / Stdio</button>
          <button type="button" class="type-tab" data-type="env">Env vars</button>
        </div>
      </div>
      <div id="mcp-url-fields" style="${isUrl ? '' : 'display:none'}">
        <div class="form-row">
          <label>URL</label>
          <input type="url" name="url" value="${escapeAttr(mcp?.url || '')}" placeholder="http://localhost:39300/.../mcp" />
        </div>
        <div class="form-row">
          <label>Request timeout (ms, optional)</label>
          <input type="number" name="requestTimeout" value="${mcp?.requestTimeout ?? ''}" placeholder="120000 = 2 min (default)" min="10000" step="1000" />
          <div class="form-row-hint">Increase if tools like Pieces memory creation timeout. Default 120000.</div>
        </div>
        <div class="form-row">
          <label>Bearer token (optional)</label>
          <div class="token-controls">
            <input type="text" name="authorizationToken" value="${escapeAttr(mcp?.authorizationToken || '')}" placeholder="env:VAR_NAME or secret:key" />
            <div class="token-buttons">
              <button type="button" class="btn btn-ghost btn-generate-token" title="Generate random token and store securely">Generate</button>
              <button type="button" class="btn btn-ghost btn-store-token" title="Paste and store a token">Store custom</button>
            </div>
          </div>
          <div class="form-row-hint">Use <code>env:VAR_NAME</code> to read from process.env, or <code>secret:key</code> to use a stored token. Or generate/store one above.</div>
        </div>
      </div>
      <div id="mcp-stdio-fields" style="${isUrl ? 'display:none' : ''}">
        <div class="form-row">
          <label>Command</label>
          <input type="text" name="command" value="${escapeAttr(mcp?.command || 'node')}" placeholder="node" />
        </div>
        <div class="form-row">
          <label>Args (comma-separated or JSON array)</label>
          <input type="text" name="args" value="${escapeAttr(Array.isArray(mcp?.args) ? mcp.args.join(', ') : '')}" placeholder="./build/index.js" />
          <div class="form-row-hint">e.g. -y, @modelcontextprotocol/server-filesystem or JSON array ["-y","pkg"]</div>
        </div>
        <div class="form-row">
          <label>Working directory (optional)</label>
          <input type="text" name="cwd" value="${escapeAttr(mcp?.cwd || '')}" placeholder="Path to run command from" />
        </div>
      </div>
      <div id="mcp-env-fields" style="display:none" data-loaded="false">
        <div id="mcp-env-schema-container">
          <p class="auth-modal-intro">Loading required env vars…</p>
        </div>
      </div>
      <div class="form-row" style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border)">
        <label class="checkbox-row">
          <input type="checkbox" name="startOnStartup" ${mcp?.startOnStartup ? 'checked' : ''} />
          <span>Start on startup</span>
        </label>
        <div class="form-row-hint">When the orchestrator server starts, automatically spin up this MCP so it's ready to use.</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onclick="hideModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `;
  showModal(content);

  const form = document.getElementById('mcp-form');
  document.querySelectorAll('.type-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.type-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.type;
      document.getElementById('mcp-url-fields').style.display = type === 'url' ? 'block' : 'none';
      document.getElementById('mcp-stdio-fields').style.display = type === 'stdio' ? 'block' : 'none';
      const envFields = document.getElementById('mcp-env-fields');
      envFields.style.display = type === 'env' ? 'block' : 'none';
      if (type === 'env' && envFields.dataset.loaded !== 'true') {
        envFields.dataset.loaded = 'true';
        await renderMcpEnvSchema(mcp, existingName, form);
      }
    });
  });

  form.querySelector('.btn-generate-token')?.addEventListener('click', async () => {
    const name = form.querySelector('input[name="name"]')?.value?.trim();
    if (!name) {
      alert('Enter MCP name first');
      return;
    }
    try {
      const { token } = await api('/secrets/generate', { method: 'POST', body: '{}' });
      await api('/secrets/' + encodeURIComponent(name), {
        method: 'PUT',
        body: JSON.stringify({ value: token }),
      });
      form.querySelector('input[name="authorizationToken"]').value = `secret:${name}`;
    } catch (err) {
      alert(err?.message || 'Failed to generate token');
    }
  });

  form.querySelector('.btn-store-token')?.addEventListener('click', async () => {
    const name = form.querySelector('input[name="name"]')?.value?.trim();
    if (!name) {
      alert('Enter MCP name first');
      return;
    }
    const token = prompt('Paste the Bearer token to store:');
    if (token === null || !token.trim()) return;
    try {
      await api('/secrets/' + encodeURIComponent(name), {
        method: 'PUT',
        body: JSON.stringify({ value: token.trim() }),
      });
      form.querySelector('input[name="authorizationToken"]').value = `secret:${name}`;
    } catch (err) {
      alert(err?.message || 'Failed to store token');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = fd.get('name').trim();
    const urlTab = document.querySelector('.type-tab[data-type="url"]').classList.contains('active');

    const startOnStartup = form.querySelector('input[name="startOnStartup"]')?.checked ?? false;

    let mcpConfig;
    if (urlTab) {
      const url = fd.get('url').trim();
      if (!url) return alert('URL is required');
      const timeoutVal = fd.get('requestTimeout');
      const requestTimeout = timeoutVal && Number(timeoutVal) > 0 ? Number(timeoutVal) : undefined;
      const authToken = fd.get('authorizationToken')?.trim() || undefined;
      mcpConfig = { type: 'url', url, ...(requestTimeout ? { requestTimeout } : {}), ...(authToken ? { authorizationToken: authToken } : {}), startOnStartup: startOnStartup || undefined };
    } else {
      const argsStr = fd.get('args').trim();
      let args = [];
      if (argsStr) {
        const t = argsStr.trim();
        if (t.startsWith('[')) {
          try {
            const parsed = JSON.parse(t);
            args = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
          } catch {
            args = argsStr.split(',').map((s) => s.trim()).filter(Boolean);
          }
        } else {
          args = argsStr.split(',').map((s) => s.trim()).filter(Boolean);
        }
      }
      let env;
      try {
        const envStr = fd.get('env')?.trim() || '';
        env = envStr ? (JSON.parse(envStr) || {}) : undefined;
        if (env && typeof env !== 'object') env = undefined;
      } catch {
        env = undefined;
      }
      mcpConfig = {
        type: 'stdio',
        command: fd.get('command').trim() || 'node',
        args: args.length ? args : undefined,
        cwd: fd.get('cwd').trim() || undefined,
        env: env && Object.keys(env).length ? env : undefined,
        startOnStartup: startOnStartup || undefined,
      };
    }

    const existingMcp = existingName ? config.mcps[existingName] : null;
    if (existingName && existingName !== name) delete config.mcps[existingName];
    if (existingMcp && existingMcp.enabled !== undefined) {
      mcpConfig.enabled = existingMcp.enabled;
    } else if (mcpConfig.enabled === undefined) {
      mcpConfig.enabled = true;
    }
    config.mcps[name] = mcpConfig;
    await saveConfig();
    await loadTools();
    renderMcpsPanel();
    checkMcpStatus();
    hideModal();
  });
}

function renderWorkflowItem(w, i) {
  const stepsDesc = w.steps.map((s) => `${s.mcp}/${s.tool}`).join(' → ');
  return `
    <div class="workflow-item" data-index="${i}">
      <div class="workflow-item-header">
        <div>
          <div class="workflow-item-title">${escapeHtml(w.name)}</div>
          <div class="workflow-item-meta">${escapeHtml(w.description || stepsDesc)}</div>
        </div>
        <div class="workflow-item-actions">
          <button type="button" class="btn btn-ghost btn-edit-workflow">Edit</button>
          <button type="button" class="btn btn-danger btn-delete-workflow">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function renderWorkflowsPanel() {
  const list = document.getElementById('workflows-list');
  if (config.workflows.length === 0) {
    list.innerHTML = '<div class="empty-state">No workflows yet. Add one and chain MCP actions together.</div>';
    return;
  }
  list.innerHTML = config.workflows.map((w, i) => renderWorkflowItem(w, i)).join('');

  list.querySelectorAll('.btn-edit-workflow').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingWorkflowIndex = parseInt(btn.closest('.workflow-item').dataset.index, 10);
      showWorkflowModal();
    });
  });
  list.querySelectorAll('.btn-delete-workflow').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.closest('.workflow-item').dataset.index, 10);
      if (!confirm(`Delete workflow "${config.workflows[i].name}"?`)) return;
      config.workflows.splice(i, 1);
      await saveConfig();
      renderWorkflowsPanel();
      renderSchedulePanel();
      renderRunPanel();
    });
  });
}

function showWorkflowModal(existingIndex = null) {
  const idx = existingIndex ?? editingWorkflowIndex;
  const w = idx >= 0 ? config.workflows[idx] : null;
  const steps = w ? [...w.steps] : [];

  const mcpKeys = Object.keys(config.mcps);
  const stepsHtml = steps
    .map(
      (s, i) => {
        const tools = toolsByMcp[s.mcp] || [];
        return `
      <div class="step-block" data-step="${i}">
        <div class="step-row">
          <select name="mcp" class="mcp-select">${mcpKeys.map((m) => `<option value="${escapeAttr(m)}" ${s.mcp === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select>
          <select name="tool" class="tool-select">${tools.map((t) => `<option value="${escapeAttr(t.name)}" ${s.tool === t.name ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
          <div class="args-wrapper">
            <div class="args-mode-toggle">
              <button type="button" class="args-mode-btn active" data-mode="edit">Edit</button>
              <button type="button" class="args-mode-btn" data-mode="preview" title="">Preview</button>
              <button type="button" class="args-fill-template hidden" title="Fill with template from tool schema">Fill template</button>
            </div>
            <div class="args-content">
              <textarea class="args-input" placeholder='{} = no args'>${escapeHtml(JSON.stringify(s.args || {}, null, 2))}</textarea>
              <div class="args-preview hidden"></div>
            </div>
          </div>
          <div class="step-actions">
            <button type="button" class="step-test" title="Run this step to test output">Test</button>
            <button type="button" class="step-up" title="Move up">↑</button>
            <button type="button" class="step-down" title="Move down">↓</button>
            <button type="button" class="step-remove" title="Remove">✕</button>
          </div>
        </div>
        <div class="step-result hidden"></div>
      </div>
    `;
      }
    )
    .join('');

  const content = `
    <h3>${w ? 'Edit Workflow' : 'Add Workflow'}</h3>
    <form id="workflow-form">
      <div class="form-row">
        <label>Name</label>
        <input type="text" name="name" value="${escapeAttr(w?.name || '')}" placeholder="e.g. Spotify to Pieces" required />
      </div>
      <div class="form-row">
        <label>Description (optional)</label>
        <input type="text" name="description" value="${escapeAttr(w?.description || '')}" placeholder="What this workflow does" />
      </div>
      <div class="form-row">
        <label>Trigger</label>
        <div class="trigger-tabs">
          <button type="button" class="trigger-tab ${(w?.trigger || 'manual') === 'manual' ? 'active' : ''}" data-trigger="manual">Manual</button>
          <button type="button" class="trigger-tab ${w?.trigger === 'schedule' ? 'active' : ''}" data-trigger="schedule">Schedule</button>
        </div>
      </div>
      <div id="schedule-fields" class="form-row" style="${w?.trigger === 'schedule' ? '' : 'display:none'}">
        <div class="schedule-format-toggle">
          <button type="button" class="schedule-format-btn ${(w?.scheduleFormat || 'time') === 'time' ? 'active' : ''}" data-format="time">Time</button>
          <button type="button" class="schedule-format-btn ${w?.scheduleFormat === 'date' ? 'active' : ''}" data-format="date">Date</button>
        </div>
        <input type="hidden" name="schedule" class="schedule-input" value="${escapeAttr(w?.schedule || '')}" />
        <div id="schedule-time-fields" class="schedule-selectors ${(w?.scheduleFormat || 'time') === 'time' ? '' : 'hidden'}">
          <div class="schedule-time-row">
            <label class="schedule-label">Run</label>
            <select class="schedule-time-type">
              <option value="*/5 * * * *">Every 5 minutes</option>
              <option value="*/10 * * * *">Every 10 minutes</option>
              <option value="*/15 * * * *">Every 15 minutes</option>
              <option value="*/30 * * * *">Every 30 minutes</option>
              <option value="0 * * * *">Every hour</option>
              <option value="daily">Daily at</option>
              <option value="custom">Custom cron</option>
            </select>
            <span class="schedule-daily-wrap" style="display:none">
              <select class="schedule-hour">${Array.from({ length: 24 }, (_, i) => `<option value="${i}">${String(i).padStart(2, '0')}</option>`).join('')}</select>
              :
              <select class="schedule-minute">${[0, 15, 30, 45].map((m) => `<option value="${m}">${String(m).padStart(2, '0')}</option>`).join('')}</select>
            </span>
            <input type="text" class="schedule-custom-input hidden" placeholder="e.g. */45 * * * *" />
          </div>
        </div>
        <div id="schedule-date-fields" class="schedule-selectors ${w?.scheduleFormat === 'date' ? '' : 'hidden'}">
          <div class="schedule-date-row">
            <label class="schedule-label">Day of week</label>
            <select class="schedule-dow">
              <option value="*">Every day</option>
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
            </select>
          </div>
          <div class="schedule-date-row">
            <label class="schedule-label">Day of month</label>
            <select class="schedule-dom"><option value="*">Every day</option>${Array.from({ length: 31 }, (_, i) => { const d = i + 1; const s = d === 1 || d === 21 || d === 31 ? 'st' : d === 2 || d === 22 ? 'nd' : d === 3 || d === 23 ? 'rd' : 'th'; return `<option value="${d}">${d}${s}</option>`; }).join('')}</select>
          </div>
          <div class="schedule-date-row">
            <label class="schedule-label">Month</label>
            <select class="schedule-month"><option value="*">Every month</option>${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((name, i) => `<option value="${i + 1}">${name}</option>`).join('')}</select>
          </div>
          <div class="schedule-date-row">
            <label class="schedule-label">At</label>
            <select class="schedule-date-hour">${Array.from({ length: 24 }, (_, i) => `<option value="${i}">${String(i).padStart(2, '0')}</option>`).join('')}</select>
            :
            <select class="schedule-date-minute">${[0, 15, 30, 45].map((m) => `<option value="${m}">${String(m).padStart(2, '0')}</option>`).join('')}</select>
          </div>
          <div class="schedule-date-row">
            <label class="schedule-label">Or custom</label>
            <input type="text" class="schedule-date-custom-input" placeholder="e.g. 0 0 * * 1" style="max-width:200px" />
          </div>
        </div>
        <div class="schedule-cron-preview form-row-hint"></div>
      </div>
      <div class="form-row">
        <label>Steps</label>
        <div class="form-row-hint">Args: JSON object. Natural text works: <code>"summary": "This is my song: {{step0}}"</code> — <code>{{step0}}</code> must be inside quotes.</div>
        <div id="steps-container">${stepsHtml || ''}</div>
        <button type="button" class="btn btn-ghost add-step-btn">+ Add step</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onclick="hideModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `;
  showModal(content);

  document.querySelectorAll('.trigger-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.trigger-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isSchedule = tab.dataset.trigger === 'schedule';
      document.getElementById('schedule-fields').style.display = isSchedule ? 'block' : 'none';
    });
  });
  function buildCronFromFields() {
    const format = document.querySelector('.schedule-format-btn.active')?.dataset.format || 'time';
    const input = document.querySelector('.schedule-input');
    const preview = document.querySelector('.schedule-cron-preview');
    if (!input || !preview) return;

    let cron = '';
    if (format === 'time') {
      const typeSel = document.querySelector('.schedule-time-type');
      const type = typeSel?.value;
      const customIn = document.querySelector('.schedule-custom-input');
      if (type === 'daily') {
        const h = document.querySelector('.schedule-hour')?.value ?? '0';
        const m = document.querySelector('.schedule-minute')?.value ?? '0';
        cron = `${m} ${h} * * *`;
      } else if (type === 'custom' && customIn?.value.trim()) {
        cron = customIn.value.trim();
      } else if (type && type !== 'custom') {
        cron = type;
      } else {
        cron = '*/30 * * * *';
      }
    } else {
      const customDate = document.querySelector('.schedule-date-custom-input')?.value?.trim();
      if (customDate) {
        cron = customDate;
      } else {
        const dow = document.querySelector('.schedule-dow')?.value ?? '*';
        const dom = document.querySelector('.schedule-dom')?.value ?? '*';
        const month = document.querySelector('.schedule-month')?.value ?? '*';
        const h = document.querySelector('.schedule-date-hour')?.value ?? '0';
        const m = document.querySelector('.schedule-date-minute')?.value ?? '0';
        cron = `${m} ${h} ${dom} ${month} ${dow}`;
      }
    }
    input.value = cron;
    preview.textContent = cron ? `Cron: ${cron}` : '';
  }

  document.querySelectorAll('.schedule-format-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.schedule-format-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const format = btn.dataset.format;
      document.getElementById('schedule-time-fields').classList.toggle('hidden', format !== 'time');
      document.getElementById('schedule-date-fields').classList.toggle('hidden', format !== 'date');
      buildCronFromFields();
    });
  });

  document.querySelector('.schedule-time-type')?.addEventListener('change', () => {
    const type = document.querySelector('.schedule-time-type')?.value;
    const wrap = document.querySelector('.schedule-daily-wrap');
    const customIn = document.querySelector('.schedule-custom-input');
    wrap.style.display = type === 'daily' ? 'inline' : 'none';
    customIn.classList.toggle('hidden', type !== 'custom');
    buildCronFromFields();
  });
  document.querySelectorAll('.schedule-hour, .schedule-minute, .schedule-dow, .schedule-dom, .schedule-month, .schedule-date-hour, .schedule-date-minute').forEach((el) => {
    el.addEventListener('change', buildCronFromFields);
  });
  document.querySelector('.schedule-custom-input')?.addEventListener('input', buildCronFromFields);
  document.querySelector('.schedule-date-custom-input')?.addEventListener('input', () => {
    const custom = document.querySelector('.schedule-date-custom-input')?.value?.trim();
    if (custom) buildCronFromFields();
  });
  document.querySelector('.schedule-date-custom-input')?.addEventListener('change', buildCronFromFields);

  function parseAndInitSchedule() {
    const s = (w?.schedule || '').trim();
    const format = (w?.scheduleFormat || 'time');
    const typeSel = document.querySelector('.schedule-time-type');
    const dowSel = document.querySelector('.schedule-dow');
    const domSel = document.querySelector('.schedule-dom');
    const monthSel = document.querySelector('.schedule-month');

    if (!s) {
      buildCronFromFields();
      return;
    }

    const parts = s.split(/\s+/);
    if (parts.length >= 5 && format === 'date') {
      const [min, hr, dom, month, dow] = parts;
      const simpleValues = (v) => /^\d+$|\*/.test(v);
      if (simpleValues(dow) && simpleValues(dom) && simpleValues(month) && /^\d+$/.test(min) && /^\d+$/.test(hr)) {
        if (dowSel) dowSel.value = dow;
        if (domSel) domSel.value = dom;
        if (monthSel) monthSel.value = month;
        const hourSel = document.querySelector('.schedule-date-hour');
        const minSel = document.querySelector('.schedule-date-minute');
        if (hourSel) hourSel.value = hr;
        if (minSel) minSel.value = min;
        document.querySelector('.schedule-date-custom-input').value = '';
      } else {
        document.querySelector('.schedule-date-custom-input').value = s;
      }
    } else if (parts.length >= 5 && format === 'time') {
      const [min, hr] = parts;
      const presetVal = ['*/5 * * * *', '*/10 * * * *', '*/15 * * * *', '*/30 * * * *', '0 * * * *'].find((p) => p === s);
      const customIn = document.querySelector('.schedule-custom-input');
      if (presetVal && typeSel) {
        typeSel.value = presetVal;
        document.querySelector('.schedule-daily-wrap').style.display = 'none';
        if (customIn) { customIn.classList.add('hidden'); customIn.value = ''; }
      } else if (/^\d+ \d+ \* \* \*$/.test(s) && typeSel) {
        typeSel.value = 'daily';
        document.querySelector('.schedule-daily-wrap').style.display = 'inline';
        document.querySelector('.schedule-hour').value = hr;
        document.querySelector('.schedule-minute').value = min;
        if (customIn) { customIn.classList.add('hidden'); customIn.value = ''; }
      } else if (typeSel && customIn) {
        typeSel.value = 'custom';
        customIn.value = s;
        customIn.classList.remove('hidden');
        document.querySelector('.schedule-daily-wrap').style.display = 'none';
      }
    }
    buildCronFromFields();
  }
  parseAndInitSchedule();

  const container = document.getElementById('steps-container');
  const stepOutputsByBlock = new Map();

  const STEP_REF_REGEX = /\{\{step(\d+)/g;

  function getReferencedStepIndices(argsStr) {
    const indices = new Set();
    try {
      const obj = argsStr.trim() ? JSON.parse(argsStr) : {};
      const search = (o) => {
        if (typeof o === 'string') {
          for (const m of o.matchAll(STEP_REF_REGEX)) indices.add(parseInt(m[1], 10));
        } else if (Array.isArray(o)) {
          o.forEach(search);
        } else if (o && typeof o === 'object') {
          Object.values(o).forEach(search);
        }
      };
      search(obj);
    } catch (_) {}
    return indices;
  }

  const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;
  const STEP_PATTERN = /^step(\d+)(?:\.([^:}]+)|:regex:([^}]+)|:regexAll:([^}]+))?$/;

  function getDateValues() {
    const d = new Date();
    const iso = d.toISOString();
    return {
      now: iso,
      isoDateTime: iso,
      isoDate: iso.slice(0, 10),
      isoTime: iso.slice(11, 23),
      timestamp: d.getTime(),
      date: d.toLocaleDateString(),
      year: d.getFullYear().toString(),
      month: (d.getMonth() + 1).toString(),
      day: d.getDate().toString(),
      weekday: d.toLocaleDateString(undefined, { weekday: 'long' }),
    };
  }

  const BUILTINS = {
    uuid: () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)),
    now: () => getDateValues().now,
    isoDateTime: () => getDateValues().isoDateTime,
    isoDate: () => getDateValues().isoDate,
    isoTime: () => getDateValues().isoTime,
    timestamp: () => getDateValues().timestamp,
    date: () => getDateValues().date,
    year: () => getDateValues().year,
    month: () => getDateValues().month,
    day: () => getDateValues().day,
    weekday: () => getDateValues().weekday,
  };

  function getByPath(obj, path) {
    const pathStr = path.trim();
    if (!pathStr) return obj;
    const parts = [];
    let rest = pathStr;
    while (rest) {
      rest = rest.replace(/^\./, '');
      if (!rest) break;
      const bracketIdx = rest.indexOf('[');
      const dotIdx = rest.indexOf('.');
      if (bracketIdx >= 0 && (dotIdx < 0 || bracketIdx < dotIdx)) {
        if (bracketIdx > 0) parts.push(rest.slice(0, bracketIdx));
        const closeIdx = rest.indexOf(']', bracketIdx);
        if (closeIdx < 0) return undefined;
        const indexStr = rest.slice(bracketIdx + 1, closeIdx).trim();
        const num = /^\d+$/.test(indexStr) ? parseInt(indexStr, 10) : NaN;
        parts.push(isNaN(num) ? indexStr.replace(/^["']|["']$/g, '') : num);
        rest = rest.slice(closeIdx + 1);
      } else if (dotIdx >= 0) {
        parts.push(rest.slice(0, dotIdx));
        rest = rest.slice(dotIdx);
      } else {
        parts.push(rest);
        rest = '';
      }
    }
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = typeof p === 'number' ? cur[p] : cur[p];
    }
    return cur;
  }

  function evalExpr(expr) {
    const now = new Date();
    const scope = { now, date: now, Date, timestamp: Date.now(), Math, JSON };
    try {
      return new Function(...Object.keys(scope), `return (${expr.trim()})`)(...Object.values(scope));
    } catch {
      return '';
    }
  }

  function resolvePlaceholderContent(content, stepOutputs, input) {
    const t = content.trim();
    if (t.startsWith('input.')) {
      const path = t.slice(6).trim();
      if (input != null) {
        const val = getByPath(input, path);
        return val !== undefined && val !== null ? val : '';
      }
      return '';
    }
    if (t.startsWith('date.')) {
      const key = t.slice(5).trim();
      const vals = getDateValues();
      return key in vals ? vals[key] : '';
    }
    if (BUILTINS[t]) return BUILTINS[t]();
    if (t.startsWith('js:')) return evalExpr(t.slice(3));
    const stepM = t.match(STEP_PATTERN);
    if (stepM) {
      const raw = stepOutputs[parseInt(stepM[1], 10)] ?? '';
      if (stepM[2]) {
        try {
          const val = getByPath(JSON.parse(raw), stepM[2]);
          return val !== undefined ? val : '';
        } catch {
          return '';
        }
      }
      if (stepM[3]) {
        const pattern = stepM[3].replace(/:array$/, '').trim();
        const m = new RegExp(pattern).exec(raw);
        const val = m?.[1] ?? '';
        return stepM[3].endsWith(':array') ? (val ? [val] : []) : val;
      }
      if (stepM[4]) {
        const pattern = stepM[4].replace(/:array$/, '').trim();
        const matches = [...raw.matchAll(new RegExp(pattern, 'g'))];
        return matches.map((m) => m[1]).filter((s) => s !== undefined);
      }
      return raw;
    }
    return '';
  }

  function substituteStepOutputs(obj, stepOutputs, input) {
    if (typeof obj === 'string') {
      const matches = [...obj.matchAll(new RegExp(PLACEHOLDER_REGEX.source, 'g'))];
      if (matches.length === 0) return obj;
      const singleMatch = matches.length === 1 && matches[0] && obj.trim() === matches[0][0];
      if (singleMatch) {
        return resolvePlaceholderContent(matches[0][1], stepOutputs, input);
      }
      return obj.replace(PLACEHOLDER_REGEX, (_, c) => {
        const r = resolvePlaceholderContent(c, stepOutputs, input);
        return typeof r === 'object' ? JSON.stringify(r) : String(r);
      });
    }
    if (Array.isArray(obj)) return obj.map((item) => substituteStepOutputs(item, stepOutputs, input));
    if (obj && typeof obj === 'object') {
      const r = {};
      for (const [k, v] of Object.entries(obj)) r[k] = substituteStepOutputs(v, stepOutputs, input);
      return r;
    }
    return obj;
  }

  function refreshPreviewState(block) {
    const argsInput = block.querySelector('.args-input');
    const previewDiv = block.querySelector('.args-preview');
    const editBtn = block.querySelector('.args-mode-btn[data-mode="edit"]');
    const previewBtn = block.querySelector('.args-mode-btn[data-mode="preview"]');
    const blocks = Array.from(container.querySelectorAll('.step-block'));
    const stepOutputs = blocks.map((b) => stepOutputsByBlock.get(b) ?? '');

    const refs = getReferencedStepIndices(argsInput.value);
    const missing = [...refs].filter((i) => i >= 0 && i < blocks.length && !stepOutputsByBlock.has(blocks[i]));
    const canPreview = missing.length === 0;

    previewBtn.disabled = !canPreview;
    previewBtn.title = canPreview ? '' : (refs.size > 0 ? `Test step ${[...refs].filter((i) => i >= 0 && i < blocks.length && !stepOutputsByBlock.has(blocks[i])).sort((a, b) => a - b).join(', ')} first` : '');

    const isPreview = previewBtn.classList.contains('active');
    if (isPreview && canPreview) {
      argsInput.classList.add('hidden');
      try {
        const argsStr = argsInput.value.trim();
        if (!argsStr) {
          previewDiv.textContent = '{}';
          previewDiv.classList.remove('is-error');
        } else {
          const args = JSON.parse(argsStr);
          if (typeof args !== 'object' || args === null || Array.isArray(args)) {
            throw new Error('Args must be a JSON object');
          }
          const subbed = substituteStepOutputs(args, stepOutputs, {});
          previewDiv.textContent = JSON.stringify(subbed, null, 2);
          previewDiv.classList.remove('is-error');
        }
      } catch {
        previewDiv.textContent = 'Args must be a JSON object. Example: {"summary": "{{step0}}"}';
        previewDiv.classList.add('is-error');
      }
      previewDiv.classList.remove('hidden');
    } else {
      previewDiv.classList.add('hidden');
      argsInput.classList.remove('hidden');
    }
  }

  function refreshAllPreviews() {
    container.querySelectorAll('.step-block').forEach(refreshPreviewState);
  }

  function addStep(mcp = null, tool = null, args = {}) {
    const mcpName = mcp || Object.keys(config.mcps)[0] || '';
    const tools = toolsByMcp[mcpName] || [];
    const toolName = tool || (tools[0]?.name) || '';
    const row = document.createElement('div');
    const block = document.createElement('div');
    block.className = 'step-block';
    block.dataset.step = container.children.length;
    block.innerHTML = `
      <div class="step-row">
        <select name="mcp" class="mcp-select">${Object.keys(config.mcps).map((m) => `<option value="${escapeAttr(m)}" ${m === mcpName ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select>
        <select name="tool" class="tool-select">${tools.map((t) => `<option value="${escapeAttr(t.name)}" ${t.name === toolName ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
        <div class="args-wrapper">
          <div class="args-mode-toggle">
            <button type="button" class="args-mode-btn active" data-mode="edit">Edit</button>
            <button type="button" class="args-mode-btn" data-mode="preview">Preview</button>
            <button type="button" class="args-fill-template hidden" title="Fill with template from tool schema">Fill template</button>
          </div>
          <div class="args-content">
            <textarea class="args-input" placeholder='{} = no args'>${escapeHtml(JSON.stringify(args, null, 2))}</textarea>
            <div class="args-preview hidden"></div>
          </div>
        </div>
        <div class="step-actions">
          <button type="button" class="step-test" title="Run this step to test output">Test</button>
          <button type="button" class="step-up" title="Move up">↑</button>
          <button type="button" class="step-down" title="Move down">↓</button>
          <button type="button" class="step-remove" title="Remove">✕</button>
        </div>
      </div>
      <div class="step-result hidden"></div>
    `;
    container.appendChild(block);
    bindStepRow(block);
    const argsInput = block.querySelector('.args-input');
    if (argsInput && (!argsInput.value.trim() || argsInput.value.trim() === '{}')) {
      const mcpSel = block.querySelector('.mcp-select');
      const toolSel = block.querySelector('.tool-select');
      const tools = toolsByMcp[mcpSel?.value] || [];
      const toolDef = tools.find((t) => t.name === toolSel?.value);
      if (toolDef?.inputSchema) {
        const template = schemaToTemplate(toolDef.inputSchema);
        if (Object.keys(template).length > 0) argsInput.value = JSON.stringify(template, null, 2);
      }
    }
    refreshAllPreviews();
  }

  function bindStepRow(block) {
    const row = block.querySelector('.step-row');
    const mcpSelect = block.querySelector('.mcp-select');
    const toolSelect = block.querySelector('.tool-select');
    const argsInput = block.querySelector('.args-input');
    const resultDiv = block.querySelector('.step-result');

    function maybeFillArgsFromSchema(force = false) {
      const mcp = mcpSelect.value;
      const tool = toolSelect.value;
      const tools = toolsByMcp[mcp] || [];
      const toolDef = tools.find((t) => t.name === tool);
      if (!toolDef?.inputSchema) return;
      const argsInput = block.querySelector('.args-input');
      const current = argsInput.value.trim();
      const template = schemaToTemplate(toolDef.inputSchema);
      if (Object.keys(template).length === 0) return;
      const userHasEdited = block.dataset.argsUserEdited === '1';
      if (!force && userHasEdited) return;
      const isEmpty = !current || current === '{}';
      const alreadyMatches = argsMatchTemplate(current, template);
      if (!force && !isEmpty && alreadyMatches) return;
      argsInput.value = JSON.stringify(template, null, 2);
      delete block.dataset.argsUserEdited;
      refreshPreviewState(block);
      updateFillTemplateVisibility();
    }

    function argsMatchTemplate(current, template) {
      try {
        const curr = JSON.parse(current);
        if (typeof curr !== 'object' || curr === null) return false;
        for (const k of Object.keys(template)) {
          if (!(k in curr) || curr[k] !== template[k]) return false;
        }
        return Object.keys(curr).length === Object.keys(template).length;
      } catch {
        return false;
      }
    }

    function updateFillTemplateVisibility() {
      const fillBtn = block.querySelector('.args-fill-template');
      if (!fillBtn) return;
      const mcp = mcpSelect.value;
      const tool = toolSelect.value;
      const tools = toolsByMcp[mcp] || [];
      const toolDef = tools.find((t) => t.name === tool);
      if (!toolDef?.inputSchema) {
        fillBtn.classList.add('hidden');
        return;
      }
      const template = schemaToTemplate(toolDef.inputSchema);
      if (Object.keys(template).length === 0) {
        fillBtn.classList.add('hidden');
        return;
      }
      const current = argsInput.value.trim();
      if (!current || current === '{}' || argsMatchTemplate(current, template)) {
        fillBtn.classList.add('hidden');
      } else {
        fillBtn.classList.remove('hidden');
      }
    }

    mcpSelect.addEventListener('change', () => {
      const tools = toolsByMcp[mcpSelect.value] || [];
      toolSelect.innerHTML = tools.map((t) => `<option value="${escapeAttr(t.name)}">${escapeHtml(t.name)}</option>`).join('');
      if (tools.length) {
        toolSelect.value = tools[0].name;
        maybeFillArgsFromSchema();
      }
      updateFillTemplateVisibility();
    });

    toolSelect.addEventListener('change', () => {
      maybeFillArgsFromSchema();
      updateFillTemplateVisibility();
    });

    argsInput.addEventListener('input', () => {
      block.dataset.argsUserEdited = '1';
      updateFillTemplateVisibility();
    });

    block.querySelector('.args-fill-template')?.addEventListener('click', () => maybeFillArgsFromSchema(true));

    block.querySelector('.step-test').addEventListener('click', async () => {
      const btn = block.querySelector('.step-test');
      const blocks = Array.from(container.querySelectorAll('.step-block'));
      const stepIndex = blocks.indexOf(block);
      if (stepIndex < 0) return;

      btn.disabled = true;
      btn.textContent = '…';
      const stepOutputs = [];

      function showResult(div, out, success) {
        div.classList.remove('hidden');
        div.className = 'step-result';
        div.classList.toggle('error', !success);
        const text = out || '(no output)';
        if (!success && (text.startsWith('Error:') || text.toLowerCase().includes('required') || text.includes('401') || text.includes('timeout') || text.includes('ECONNREFUSED'))) {
          div.innerHTML = renderPrettyError(formatMcpError(text));
          return;
        }
        try {
          const parsed = text.trim() && text.trim().startsWith('{') ? JSON.parse(text) : null;
          if (parsed && typeof parsed === 'object') {
            div.innerHTML = `<pre>${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
          } else {
            div.innerHTML = formatStepOutput(text);
          }
        } catch {
          div.innerHTML = formatStepOutput(text);
        }
      }

      try {
        for (let i = 0; i <= stepIndex; i++) {
          const b = blocks[i];
          const mcp = b.querySelector('.mcp-select').value;
          const tool = b.querySelector('.tool-select').value;
          const rDiv = b.querySelector('.step-result');
          rDiv.classList.remove('hidden');
          rDiv.textContent = i < stepIndex ? `Running prerequisite…` : 'Running…';
          rDiv.className = 'step-result';

          let args = {};
          try {
            const argsStr = b.querySelector('.args-input').value.trim();
            args = argsStr ? JSON.parse(argsStr) : {};
          } catch {
            rDiv.textContent = 'Invalid JSON in args';
            rDiv.classList.add('error');
            break;
          }

          const subbed = substituteStepOutputs(args, stepOutputs, {});
          const { success, output } = await api('/step', {
            method: 'POST',
            body: JSON.stringify({ mcp, tool, args: subbed }),
          });

          const out = output || '';
          stepOutputs.push(out);
          if (success) stepOutputsByBlock.set(b, out);
          showResult(rDiv, out, success);

          if (!success) break;
        }
        refreshAllPreviews();
      } catch (err) {
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = renderPrettyError(formatMcpError(err.message));
        resultDiv.classList.add('error');
      }
      btn.disabled = false;
      btn.textContent = 'Test';
    });

    block.querySelector('.args-mode-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('.args-mode-btn');
      if (!btn || btn.disabled) return;
      block.querySelectorAll('.args-mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      refreshPreviewState(block);
    });

    block.querySelector('.step-up').addEventListener('click', () => {
      const prev = block.previousElementSibling;
      if (prev && prev.classList.contains('step-block')) container.insertBefore(block, prev);
      refreshAllPreviews();
    });
    block.querySelector('.step-down').addEventListener('click', () => {
      const next = block.nextElementSibling;
      if (next && next.classList.contains('step-block')) container.insertBefore(next, block);
      refreshAllPreviews();
    });
    block.querySelector('.step-remove').addEventListener('click', () => {
      stepOutputsByBlock.delete(block);
      block.remove();
      refreshAllPreviews();
    });

    const initialContent = argsInput.value.trim();
    if (initialContent && initialContent !== '{}') {
      const mcp = mcpSelect.value;
      const tool = toolSelect.value;
      const tools = toolsByMcp[mcp] || [];
      const toolDef = tools.find((t) => t.name === tool);
      const template = toolDef?.inputSchema ? schemaToTemplate(toolDef.inputSchema) : {};
      if (Object.keys(template).length > 0 && !argsMatchTemplate(initialContent, template)) {
        block.dataset.argsUserEdited = '1';
      }
    }

    updateFillTemplateVisibility();
  }

  container.querySelectorAll('.step-block').forEach(bindStepRow);
  refreshAllPreviews();

  document.querySelector('.add-step-btn').addEventListener('click', () => addStep());

  document.getElementById('workflow-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name').trim();
    const description = fd.get('description').trim() || undefined;

    const steps = [];
    for (const block of container.querySelectorAll('.step-block')) {
      const mcp = block.querySelector('.mcp-select').value;
      const tool = block.querySelector('.tool-select').value;
      const argsStr = block.querySelector('.args-input').value.trim();
      let args = {};
      if (argsStr) {
        try {
          args = JSON.parse(argsStr);
        } catch (err) {
          alert(`Invalid JSON in step "${mcp}/${tool}": ${err.message}\n\nYour args were not saved. Fix the JSON and try again.`);
          return;
        }
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        alert('Args must be a JSON object (e.g. {} or {"key": "value"}).');
        return;
      }
      steps.push({ mcp, tool, args });
    }

    if (steps.length === 0) return alert('Add at least one step');

    const trigger = document.querySelector('.trigger-tab.active')?.dataset.trigger || 'manual';
    const scheduleStr = document.querySelector('.schedule-input')?.value?.trim();
    const scheduleFormat = trigger === 'schedule' ? (document.querySelector('.schedule-format-btn.active')?.dataset.format || 'time') : undefined;
    const workflow = {
      name,
      description,
      steps,
      trigger,
      ...(trigger === 'schedule' ? { schedule: scheduleStr || '', scheduleFormat } : {}),
    };
    if (idx >= 0) {
      config.workflows[idx] = workflow;
    } else {
      config.workflows.push(workflow);
    }
    await saveConfig();
    renderWorkflowsPanel();
    renderSchedulePanel();
    renderRunPanel();
    hideModal();
    editingWorkflowIndex = -1;
  });
}

function renderSchedulePanel() {
  const list = document.getElementById('schedule-list');
  const scheduled = config.workflows.filter((w) => w.trigger === 'schedule' && w.schedule?.trim());
  if (scheduled.length === 0) {
    list.innerHTML = '<div class="empty-state">No scheduled workflows. Edit a workflow and set Trigger to Schedule with a cron expression.</div>';
    return;
  }
  list.innerHTML = scheduled
    .map(
      (w) => `
    <div class="schedule-item">
      <div class="schedule-item-info">
        <strong>${escapeHtml(w.name)}</strong>
        <code class="schedule-cron">${escapeHtml(w.schedule)}</code>
      </div>
      <div class="schedule-item-actions">
        <button type="button" class="btn btn-ghost btn-edit-workflow" data-index="${config.workflows.indexOf(w)}">Edit</button>
        <button type="button" class="btn btn-danger btn-unschedule" data-index="${config.workflows.indexOf(w)}">Unschedule</button>
      </div>
    </div>
  `,
    )
    .join('');
  list.querySelectorAll('.btn-edit-workflow').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingWorkflowIndex = parseInt(btn.dataset.index, 10);
      showWorkflowModal();
    });
  });
  list.querySelectorAll('.btn-unschedule').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const w = config.workflows[idx];
      if (!w) return;
      if (!confirm(`Unschedule "${w.name}"? It will become a manual-only workflow.`)) return;
      config.workflows[idx] = { ...w, trigger: 'manual', schedule: '', scheduleFormat: undefined };
      await saveConfig();
      renderWorkflowsPanel();
      renderSchedulePanel();
      renderRunPanel();
      await appendLogToServer('config', `Unscheduled workflow "${w.name}"`);
    });
  });
}

function renderRunPanel() {
  const list = document.getElementById('run-workflows');
  if (config.workflows.length === 0) {
    list.innerHTML = '<div class="empty-state">No workflows to run. Add one in the Workflows tab.</div>';
    return;
  }
  list.innerHTML = config.workflows
    .map(
      (w) => `
    <div class="run-card" data-name="${escapeAttr(w.name)}">
      <div class="run-card-info">
        <h3>${escapeHtml(w.name)}</h3>
        <p>${escapeHtml(w.description || w.steps.map((s) => `${s.mcp}/${s.tool}`).join(' → '))}</p>
      </div>
      <button type="button" class="btn btn-primary run-btn">Run</button>
    </div>
  `
    )
    .join('');

  list.querySelectorAll('.run-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.run-card');
      const name = card.dataset.name;
      card.classList.add('running');
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span>';

      const outputEl = document.getElementById('output');
      outputEl.classList.remove('error');
      outputEl.innerHTML = '';

      try {
        let input;
        const inputEl = document.getElementById('run-input');
        if (inputEl?.value.trim()) {
          try {
            input = JSON.parse(inputEl.value.trim());
          } catch (_) {
            outputEl.innerHTML = renderPrettyError('Invalid JSON in Input field');
            outputEl.classList.add('error');
            btn.disabled = false;
            btn.textContent = 'Run';
            card.classList.remove('running');
            return;
          }
        }
        const { success, stepOutputs } = await api('/workflow/' + encodeURIComponent(name), {
          method: 'POST',
          body: JSON.stringify(input != null ? { input } : {}),
        });
        card.classList.remove('running');
        card.classList.add(success ? 'success' : 'error');

        const text = stepOutputs.map((s, i) => `--- Step ${i + 1} ---\n${s}`).join('\n\n');
        const failedOutput = !success && stepOutputs.length > 0 ? stepOutputs[stepOutputs.length - 1] : '';
        const prettyErr = failedOutput ? renderPrettyError(formatMcpError(failedOutput)) : '';
        outputEl.innerHTML = prettyErr
          ? `<div class="output-error-wrap">${prettyErr}</div><pre>${escapeHtml(text)}</pre>`
          : `<pre>${escapeHtml(text || '(no output)')}</pre>`;

        await loadLogs();
      } catch (err) {
        card.classList.remove('running');
        card.classList.add('error');
        outputEl.innerHTML = renderPrettyError(formatMcpError(err.message));
        outputEl.classList.add('error');
        await loadLogs();
      }

      btn.disabled = false;
      btn.textContent = 'Run';
    });
  });
}

document.getElementById('settings-btn')?.addEventListener('click', () => activateMainTab('settings'));
document.getElementById('logs-btn')?.addEventListener('click', () => showLogsPanel());
document.getElementById('logs-close-btn')?.addEventListener('click', () => hideLogsPanel());
document.getElementById('logs-overlay')?.addEventListener('click', () => hideLogsPanel());
document.getElementById('logs-filter')?.addEventListener('change', () => renderLogsPanel());
document.querySelector('.btn-logs-download')?.addEventListener('click', async () => {
  const filter = document.getElementById('logs-filter')?.value || 'all';
  const filtered = filter === 'all' ? logStore : logStore.filter((e) => e.type === filter);
  let serverInfo = {};
  try {
    serverInfo = await api('/server-info');
  } catch (_) {}
  const exportData = {
    exportedAt: new Date().toISOString(),
    filter: filter === 'all' ? 'all' : filter,
    count: filtered.length,
    server: {
      port: serverInfo.port,
      cwd: serverInfo.cwd,
      configPath: serverInfo.configPath,
      logsPath: serverInfo.logsPath,
    },
    logs: filtered,
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mcp-orchestrator-logs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
document.querySelector('.btn-logs-clear')?.addEventListener('click', async () => {
  try {
    await api('/logs', { method: 'DELETE' });
    await loadLogs();
    document.getElementById('logs-badge')?.classList.add('hidden');
  } catch {
    await loadLogs();
  }
});

async function renderSettingsPanel() {
  const serverInfoEl = document.getElementById('settings-server-info');
  const encryptionStatusEl = document.getElementById('settings-encryption-status');
  const setupEncryptionEl = document.getElementById('settings-setup-encryption');
  const secretsListEl = document.getElementById('settings-secrets-list');
  const tunnelTokenEl = document.getElementById('settings-tunnel-token');
  const tunnelUrlEl = document.getElementById('settings-tunnel-url');
  const tunnelStatusEl = document.getElementById('settings-tunnel-status');

  try {
    const info = await api('/server-info');
    serverInfoEl.innerHTML = `
      <dl class="settings-dl">
        <dt title="Port the MCP Orchestrator server listens on (set via PORT env var)">Port</dt>
        <dd><code>${escapeHtml(String(info.port))}</code></dd>
        <dt title="Directory where config and secrets files are stored">Working directory</dt>
        <dd><code>${escapeHtml(info.cwd)}</code></dd>
        <dt title="Main config file: MCPs and workflows">Config file</dt>
        <dd><code>${escapeHtml(info.configPath)}</code></dd>
        <dt title="Gitignored file for tokens and API keys">Secrets file</dt>
        <dd><code>${escapeHtml(info.secretsPath)}</code></dd>
        <dt title="Activity and workflow run logs">Logs file</dt>
        <dd><code>${escapeHtml(info.logsPath)}</code></dd>
      </dl>
    `;
  } catch {
    serverInfoEl.innerHTML = '<p class="settings-error">Could not load server info.</p>';
  }

  // Encryption status
  try {
    const enc = await api('/secrets/encryption');
    if (enc.enabled) {
      encryptionStatusEl.innerHTML = '<p class="settings-encryption-on"><strong>Encryption:</strong> enabled (key in OS keychain)</p>';
      setupEncryptionEl.classList.add('hidden');
    } else {
      encryptionStatusEl.innerHTML = '<p class="settings-encryption-off"><strong>Encryption:</strong> not set up — secrets stored in plain text</p>';
      setupEncryptionEl.classList.remove('hidden');
    }
  } catch {
    encryptionStatusEl.innerHTML = '';
    setupEncryptionEl.classList.add('hidden');
  }

  try {
    const { keys } = await api('/secrets/keys');

    if (keys.length === 0) {
      secretsListEl.innerHTML = '<p class="settings-empty">No secrets stored yet. Add one below or configure Cloudflare tunnel above.</p>';
    } else {
      secretsListEl.innerHTML = keys
        .map(
          (key) =>
            `<div class="settings-secret-row" data-key="${escapeAttr(key)}">
              <span class="settings-secret-key-name" title="${key.startsWith(tunnelPrefix) ? 'Token for MCP: ' + key.slice(tunnelPrefix.length) : 'Secret key'}"><code>${escapeHtml(key)}</code></span>
              <span class="settings-secret-mask">●●●●●●●●</span>
              <button type="button" class="btn btn-ghost btn-delete-secret" title="Remove this secret">Delete</button>
            </div>`
        )
        .join('');

      secretsListEl.querySelectorAll('.btn-delete-secret').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.settings-secret-row');
          const key = row?.dataset.key;
          if (!key || !confirm(`Delete secret "${key}"?`)) return;
          try {
            await api(`/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' });
            renderSettingsPanel();
          } catch (err) {
            alert(err.message || 'Failed to delete');
          }
        });
      });
    }
  } catch {
    secretsListEl.innerHTML = '<p class="settings-error">Could not load secrets.</p>';
  }

  tunnelTokenEl.value = '';
  tunnelUrlEl.value = '';
  const tunnelDomainEl = document.getElementById('settings-tunnel-domain');
  if (tunnelDomainEl) tunnelDomainEl.value = '';
  tunnelStatusEl.textContent = '';
  try {
    await api('/secrets/cloudflare_tunnel_token');
    tunnelTokenEl.placeholder = '●●●●●●●● (enter new value to replace)';
  } catch {
    tunnelTokenEl.placeholder = 'Paste from Cloudflare dashboard';
  }
  try {
    await api('/secrets/cloudflare_tunnel_public_url');
    tunnelUrlEl.placeholder = '●●●●●●●● (enter new value to replace)';
  } catch {
    tunnelUrlEl.placeholder = 'https://mcp.example.com';
  }
  if (tunnelDomainEl) {
    try {
      await api('/secrets/cloudflare_tunnel_domain');
      tunnelDomainEl.placeholder = '●●●●●●●● (enter new value to replace)';
    } catch {
      tunnelDomainEl.placeholder = 'mcp.example.com';
    }
  }
}

function initSettingsPanel() {
  document.getElementById('settings-encryption-setup')?.addEventListener('click', async () => {
    const passEl = document.getElementById('settings-encryption-password');
    const password = passEl?.value ?? '';
    if (password.length < 8) {
      alert('Password must be at least 8 characters.');
      return;
    }
    try {
      await api('/secrets/setup-encryption', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      passEl.value = '';
      renderSettingsPanel();
    } catch (err) {
      alert(err.message || 'Failed to set up encryption');
    }
  });

  document.getElementById('settings-secret-add')?.addEventListener('click', async () => {
    const keyEl = document.getElementById('settings-secret-key');
    const valueEl = document.getElementById('settings-secret-value');
    const key = (keyEl?.value || '').trim();
    const value = valueEl?.value ?? '';
    if (!key) {
      alert('Enter a key name.');
      return;
    }
    try {
      await api(`/secrets/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      keyEl.value = '';
      valueEl.value = '';
      renderSettingsPanel();
    } catch (err) {
      alert(err.message || 'Failed to save secret');
    }
  });

  document.getElementById('settings-tunnel-save')?.addEventListener('click', async () => {
    const tokenEl = document.getElementById('settings-tunnel-token');
    const urlEl = document.getElementById('settings-tunnel-url');
    const domainEl = document.getElementById('settings-tunnel-domain');
    const statusEl = document.getElementById('settings-tunnel-status');
    const token = (tokenEl?.value || '').trim();
    const url = (urlEl?.value || '').trim();
    const domain = (domainEl?.value || '').trim();
    if (!token && !url && !domain) {
      statusEl.textContent = 'Enter at least token, public URL, or domain.';
      statusEl.classList.add('error');
      return;
    }
    try {
      if (token) {
        await api('/secrets/cloudflare_tunnel_token', {
          method: 'PUT',
          body: JSON.stringify({ value: token }),
        });
        tokenEl.value = '';
      }
      if (url) {
        await api('/secrets/cloudflare_tunnel_public_url', {
          method: 'PUT',
          body: JSON.stringify({ value: url }),
        });
        urlEl.value = '';
      }
      if (domain && domainEl) {
        await api('/tunnel/domain', {
          method: 'PUT',
          body: JSON.stringify({ domain }),
        });
        domainEl.value = '';
      }
      statusEl.textContent = 'Saved.';
      statusEl.classList.remove('error');
      renderSettingsPanel();
      setTimeout(() => (statusEl.textContent = ''), 2000);
    } catch (err) {
      statusEl.textContent = err.message || 'Failed to save';
      statusEl.classList.add('error');
    }
  });
}

document.getElementById('add-mcp-btn').addEventListener('click', () => showMcpModal());
document.getElementById('check-mcp-status-btn').addEventListener('click', () => checkMcpStatus());
document.getElementById('add-workflow-btn').addEventListener('click', () => {
  if (Object.keys(config.mcps).length === 0) {
    alert('Add at least one MCP first.');
    return;
  }
  editingWorkflowIndex = -1;
  showWorkflowModal();
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') hideModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) hideModal();
    else if (!document.getElementById('mcp-wiki-modal-overlay')?.classList.contains('hidden')) hideMcpWiki();
    else if (document.getElementById('logs-panel')?.classList.contains('open')) hideLogsPanel();
  }
});

async function init() {
  const outputEl = document.getElementById('output');
  outputEl.innerHTML = '<p class="placeholder">Loading...</p>';

  initTabs();
  initMcpViewToggle();
  initMcpSubTabs();
  initMcpWiki();
  initTunnelPanel();
  initConnectPanel();
  initSettingsPanel();

  try {
    await loadConfig();
    await loadTools();
    renderMcpsPanel();
    renderTunnelPanel();
    checkMcpStatus();
    renderWorkflowsPanel();
    renderSchedulePanel();
    renderRunPanel();
    loadLogs();
    outputEl.innerHTML = '<p class="placeholder">Run a workflow to see output.</p>';
  } catch (err) {
    outputEl.innerHTML = renderPrettyError(formatMcpError(err.message));
    outputEl.classList.add('error');
  }
}

init();
