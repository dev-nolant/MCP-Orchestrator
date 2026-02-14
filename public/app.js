const API = '/api';

let config = { mcps: {}, workflows: [] };
let toolsByMcp = {};
let editingWorkflowIndex = -1;
let mcpStatus = { checking: false, status: {} };

let logStore = [];

async function loadLogs() {
  try {
    logStore = await api('/logs');
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
const VALID_TABS = ['mcps', 'workflows', 'schedule', 'run', 'tunnel'];

function activateMainTab(tabId) {
  const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('panel-' + tabId)?.classList.add('active');
  if (tabId === 'run') renderRunPanel();
  if (tabId === 'schedule') renderSchedulePanel();
  if (tabId === 'mcps') checkMcpStatus();
  if (tabId === 'tunnel') renderTunnelPanel();
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

function renderMcpItem(name, mcp) {
  const isUrl = mcp.type === 'url';
  const meta = isUrl ? mcp.url : `${mcp.command} ${(mcp.args || []).join(' ')}`;
  const tools = toolsByMcp[name] || [];
  const isDisabled = mcp.enabled === false;
  const st = mcpStatus.status[name];
  const isChecking = mcpStatus.checking;
  const isOnline = !isDisabled && st?.online === true;
  const isOffline = !isDisabled && st?.online === false;
  const offlineError = isOffline ? (st.error || 'Connection failed') : '';

  let statusBadge = '';
  if (isDisabled) {
    statusBadge = '<span class="mcp-status mcp-status-stopped" title="Stopped (spin up to enable)"><span class="mcp-status-dot"></span> Stopped</span>';
  } else if (isChecking) {
    statusBadge = '<span class="mcp-status mcp-status-checking" title="Checking…"><span class="mcp-status-dot pulse"></span> Checking…</span>';
  } else if (isOnline) {
    statusBadge = `<span class="mcp-status mcp-status-online" title="Online — ${tools.length} tools"><span class="mcp-status-dot"></span> Online</span>`;
  } else if (isOffline) {
    statusBadge = `<span class="mcp-status mcp-status-offline" title="${escapeAttr(offlineError)}"><span class="mcp-status-dot"></span> Offline</span>`;
  } else {
    statusBadge = '<span class="mcp-status mcp-status-unknown" title="Click Check status">—</span>';
  }

  return `
    <div class="mcp-item ${isDisabled ? 'mcp-item-disabled' : ''}" data-name="${escapeAttr(name)}">
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

function renderMcpsPanel() {
  const list = document.getElementById('mcps-list');
  const banner = document.getElementById('mcp-checking-banner');
  if (banner) banner.classList.toggle('hidden', !mcpStatus.checking);

  const entries = Object.entries(config.mcps);
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">No MCPs yet. Add one by URL or file (stdio).</div>';
    return;
  }
  list.innerHTML = entries.map(([name, mcp]) => renderMcpItem(name, mcp)).join('');

  list.querySelectorAll('.btn-edit-mcp').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.closest('.mcp-item').dataset.name;
      showMcpModal(name);
    });
  });
  list.querySelectorAll('.btn-delete-mcp').forEach((btn) => {
    btn.addEventListener('click', async () => {
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
    btn.addEventListener('click', async () => {
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
      btn.disabled = true;
      btn.textContent = 'Installing…';
      try {
        const { name: installedName } = await api('/install-npm', {
          method: 'POST',
          body: JSON.stringify({ package: pkg }),
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
          btn.disabled = true;
          btn.textContent = 'Installing…';
          try {
            const payload = JSON.parse(card.dataset.server);
            const { name: installedName } = await api('/registry/install', { method: 'POST', body: JSON.stringify(payload) });
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
      alert(err?.message || err?.error || 'Failed to start tunnel. Install cloudflared: brew install cloudflared');
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
    tab.addEventListener('click', () => {
      document.querySelectorAll('.type-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isUrl = tab.dataset.type === 'url';
      document.getElementById('mcp-url-fields').style.display = isUrl ? 'block' : 'none';
      document.getElementById('mcp-stdio-fields').style.display = isUrl ? 'none' : 'block';
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
      mcpConfig = {
        type: 'stdio',
        command: fd.get('command').trim() || 'node',
        args: args.length ? args : undefined,
        cwd: fd.get('cwd').trim() || undefined,
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
  const mcpSelects = container.querySelectorAll('.mcp-select');
  const stepOutputsByBlock = new Map();

  function getReferencedStepIndices(argsStr) {
    const indices = new Set();
    try {
      const obj = argsStr.trim() ? JSON.parse(argsStr) : {};
      const search = (o) => {
        if (typeof o === 'string') {
          for (const m of o.matchAll(/\{\{step(\d+)\}\}/g)) indices.add(parseInt(m[1], 10));
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

  function substituteStepOutputs(obj, stepOutputs) {
    if (typeof obj === 'string') {
      return obj.replace(/\{\{step(\d+)\}\}/g, (_, i) => stepOutputs[parseInt(i, 10)] ?? '');
    }
    if (Array.isArray(obj)) return obj.map((item) => substituteStepOutputs(item, stepOutputs));
    if (obj && typeof obj === 'object') {
      const r = {};
      for (const [k, v] of Object.entries(obj)) r[k] = substituteStepOutputs(v, stepOutputs);
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
          const subbed = substituteStepOutputs(args, stepOutputs);
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
    refreshAllPreviews();
  }

  function bindStepRow(block) {
    const row = block.querySelector('.step-row');
    const mcpSelect = block.querySelector('.mcp-select');
    const toolSelect = block.querySelector('.tool-select');
    const argsInput = block.querySelector('.args-input');
    const resultDiv = block.querySelector('.step-result');

    mcpSelect.addEventListener('change', () => {
      const tools = toolsByMcp[mcpSelect.value] || [];
      toolSelect.innerHTML = tools.map((t) => `<option value="${escapeAttr(t.name)}">${escapeHtml(t.name)}</option>`).join('');
    });

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

          const subbed = substituteStepOutputs(args, stepOutputs);
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
  }

  container.querySelectorAll('.step-block').forEach(bindStepRow);
  refreshAllPreviews();

  mcpSelects.forEach((sel) => {
    sel.addEventListener('change', () => {
      const block = sel.closest('.step-block');
      const toolSelect = block.querySelector('.tool-select');
      const tools = toolsByMcp[sel.value] || [];
      toolSelect.innerHTML = tools.map((t) => `<option value="${escapeAttr(t.name)}">${escapeHtml(t.name)}</option>`).join('');
    });
  });

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
        const { success, stepOutputs } = await api('/workflow/' + encodeURIComponent(name), {
          method: 'POST',
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

document.getElementById('logs-btn')?.addEventListener('click', () => showLogsPanel());
document.getElementById('logs-close-btn')?.addEventListener('click', () => hideLogsPanel());
document.getElementById('logs-overlay')?.addEventListener('click', () => hideLogsPanel());
document.getElementById('logs-filter')?.addEventListener('change', () => renderLogsPanel());
document.querySelector('.btn-logs-download')?.addEventListener('click', () => {
  const filter = document.getElementById('logs-filter')?.value || 'all';
  const filtered = filter === 'all' ? logStore : logStore.filter((e) => e.type === filter);
  const lines = filtered.map((e) => {
    const status = e.success !== false ? 'ok' : 'failed';
    return `[${e.ts}] [${e.type}] [${status}] ${e.message}${e.detail ? '\n  ' + e.detail : ''}`;
  });
  const blob = new Blob([lines.join('\n\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mcp-orchestrator-logs-${new Date().toISOString().slice(0, 10)}.txt`;
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
    else if (document.getElementById('logs-panel')?.classList.contains('open')) hideLogsPanel();
  }
});

async function init() {
  const outputEl = document.getElementById('output');
  outputEl.innerHTML = '<p class="placeholder">Loading...</p>';

  initTabs();
  initMcpSubTabs();
  initTunnelPanel();

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
