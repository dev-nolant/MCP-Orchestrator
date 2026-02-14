#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './workflow.js';
import { startScheduler } from './scheduler.js';
import { appendLog, getLogs, clearLogs } from './logs.js';
import { loadConfig, saveConfig } from './config-loader.js';
import { startOrchestratorTunnel, stopOrchestratorTunnel, getOrchestratorTunnelUrl, getOrchestratorTunnelPersisted, isCloudflareTunnelActive, isNamedTunnelConfigured, isCloudflareLoggedIn, runCloudflareLogin, getTunnelBaseDomain, } from './tunnel.js';
import { getSecret, setSecret, deleteSecret, listSecretKeys } from './secrets.js';
import { setTunnelToken, deleteTunnelToken, generateTunnelToken, getTunnelTokenMcpNames } from './tunnel-tokens.js';
import { handleTunnelProxy } from './tunnel-proxy.js';
import { toTunnelSubdomain } from './config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.on('uncaughtException', (err) => {
    console.error('[tunnel] Uncaught exception:', err);
    appendLog({
        type: 'tunnel',
        message: `Uncaught exception: ${err.message}`,
        detail: null,
        output: { stack: err.stack },
        success: false,
    });
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[tunnel] Unhandled rejection:', reason);
    appendLog({
        type: 'tunnel',
        message: `Unhandled rejection: ${String(reason)}`,
        detail: null,
        output: null,
        success: false,
    });
});
async function main() {
    // Apply startOnStartup: spin up MCPs that should start when the server starts
    const initialConfig = loadConfig();
    let configChanged = false;
    for (const mcp of Object.values(initialConfig.mcps)) {
        const m = mcp;
        if (m.startOnStartup === true) {
            m.enabled = true;
            configChanged = true;
        }
    }
    if (configChanged)
        saveConfig(initialConfig);
    const app = express();
    // Subdomain routing: when Host is {mcpName}.{baseDomain}, proxy to that MCP
    app.use((req, res, next) => {
        const baseDomain = getTunnelBaseDomain();
        if (!baseDomain)
            return next();
        const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
        const domain = baseDomain.toLowerCase().replace(/^\.+/, '');
        if (!host.endsWith('.' + domain) && host !== domain)
            return next();
        const subdomain = host.slice(0, -(domain.length + 1));
        if (!subdomain)
            return next();
        const config = loadConfig();
        const mcpName = Object.keys(config.mcps).find((k) => toTunnelSubdomain(k, config.mcps[k]) === subdomain);
        if (!mcpName)
            return next();
        handleTunnelProxy(req, res, mcpName, { subdomainRouting: true }).catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            appendLog({ type: 'tunnel', message: `Subdomain proxy error for ${mcpName}: ${errMsg}`, detail: req.url ?? undefined, output: err instanceof Error ? { stack: err.stack } : null, success: false });
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: errMsg }));
            }
        });
    });
    // Tunnel proxy must run before express.json() so we get raw body for forwarding
    const tunnelProxyHandler = (req, res) => {
        const mcpName = req.params.mcpName;
        handleTunnelProxy(req, res, mcpName).catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            appendLog({
                type: 'tunnel',
                message: `Tunnel proxy unhandled error for ${mcpName}: ${errMsg}`,
                detail: req.url ?? undefined,
                output: err instanceof Error ? { stack: err.stack } : null,
                success: false,
            });
            console.error('[tunnel] Proxy error:', mcpName, errMsg);
            if (!res.headersSent) {
                res.status(500);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: errMsg }));
            }
        });
    };
    app.all('/tunnel/:mcpName', tunnelProxyHandler);
    app.all('/tunnel/:mcpName/*', tunnelProxyHandler);
    app.use(express.json());
    app.get('/api/config', (_req, res) => {
        res.json(loadConfig());
    });
    app.get('/api/logs', (_req, res) => {
        res.json(getLogs());
    });
    app.post('/api/logs', (req, res) => {
        try {
            const { type, message, detail, output } = req.body;
            if (!type || !message) {
                return res.status(400).json({ error: 'type and message required' });
            }
            appendLog({ type, message, detail: detail ?? null, output });
            res.json({ ok: true });
        }
        catch {
            res.status(500).json({ error: 'Failed to append log' });
        }
    });
    app.delete('/api/logs', (_req, res) => {
        try {
            clearLogs();
            res.json({ ok: true });
        }
        catch {
            res.status(500).json({ error: 'Failed to clear logs' });
        }
    });
    app.put('/api/config', (req, res) => {
        try {
            const config = req.body;
            if (!config || typeof config.mcps !== 'object' || !Array.isArray(config.workflows)) {
                return res.status(400).json({ error: 'Invalid config' });
            }
            saveConfig(config);
            startScheduler(config);
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    const REGISTRY_BASE = 'https://prod.registry.modelcontextprotocol.io';
    app.get('/api/registry/servers', async (req, res) => {
        try {
            const { cursor, limit = '20', search } = req.query;
            const params = new URLSearchParams();
            if (cursor)
                params.set('cursor', cursor);
            if (limit)
                params.set('limit', limit);
            if (search)
                params.set('search', search);
            const url = `${REGISTRY_BASE}/v0.1/servers?${params.toString()}`;
            const r = await fetch(url);
            if (!r.ok)
                throw new Error(`Registry: ${r.status} ${r.statusText}`);
            const data = await r.json();
            res.json(data);
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.post('/api/registry/install', (req, res) => {
        try {
            const { server: serverDetail } = req.body;
            if (!serverDetail?.name) {
                return res.status(400).json({ error: 'Missing server data' });
            }
            const displayName = serverDetail.title || serverDetail.name.split('/').pop() || serverDetail.name;
            const config = loadConfig();
            if (serverDetail.remotes?.length) {
                const remote = serverDetail.remotes[0];
                if (remote.type === 'streamable-http' || remote.type === 'sse') {
                    const name = displayName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');
                    const existing = Object.keys(config.mcps).filter((k) => k.toLowerCase() === name.toLowerCase())[0];
                    const finalName = existing || (Object.keys(config.mcps).includes(name) ? `${name}-${Date.now()}` : name);
                    config.mcps[finalName] = { type: 'url', url: remote.url, enabled: true };
                    saveConfig(config);
                    appendLog({
                        type: 'install',
                        message: 'Installed MCP from registry',
                        detail: `${displayName} → ${finalName}`,
                    });
                    return res.json({ ok: true, name: finalName });
                }
            }
            if (serverDetail.packages?.length) {
                const pkg = serverDetail.packages.find((p) => p.registryType === 'npm' && p.transport?.type === 'stdio') ?? serverDetail.packages[0];
                if (pkg.registryType === 'npm' && pkg.transport?.type === 'stdio') {
                    const ver = pkg.version && pkg.version !== 'latest'
                        ? `@${pkg.version}`
                        : '';
                    const id = pkg.identifier + ver;
                    const hint = pkg.runtimeHint || 'npx';
                    const runtimeArgs = Array.isArray(pkg.runtimeArguments)
                        ? pkg.runtimeArguments.map((a) => typeof a === 'object' && a && 'value' in a ? String(a.value) : String(a))
                        : ['-y'];
                    const pkgArgs = Array.isArray(pkg.packageArguments)
                        ? pkg.packageArguments.map((a) => typeof a === 'object' && a && 'value' in a ? String(a.value) : String(a))
                        : [];
                    const args = [...runtimeArgs, id, ...pkgArgs].filter(Boolean);
                    let command = hint;
                    if (hint === 'npx')
                        command = 'npx';
                    const name = displayName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');
                    const existing = Object.keys(config.mcps).filter((k) => k.toLowerCase() === name.toLowerCase())[0];
                    const finalName = existing || (Object.keys(config.mcps).includes(name) ? `${name}-${Date.now()}` : name);
                    config.mcps[finalName] = {
                        type: 'stdio',
                        command,
                        args,
                        enabled: true,
                    };
                    saveConfig(config);
                    appendLog({
                        type: 'install',
                        message: 'Installed MCP from registry',
                        detail: `${displayName} → ${finalName}`,
                    });
                    return res.json({ ok: true, name: finalName });
                }
            }
            return res.status(400).json({ error: 'No supported package or remote transport found' });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.post('/api/install-npm', (req, res) => {
        try {
            const { package: pkg, args: extraArgs = [] } = req.body;
            const pkgTrim = (pkg || '').trim();
            if (!pkgTrim || !/^@?[\w.-]+\/[\w.-]+$/.test(pkgTrim.replace(/^@/, ''))) {
                return res.status(400).json({ error: 'Invalid npm package (use format: @org/package or org/package)' });
            }
            const withAt = pkgTrim.startsWith('@') ? pkgTrim : `@${pkgTrim}`;
            const config = loadConfig();
            const baseName = withAt.split('/').pop()?.replace(/^[^a-zA-Z0-9]+/, '') || 'mcp';
            const name = baseName.replace(/[^a-zA-Z0-9-_]/g, '') || 'mcp';
            const finalName = Object.keys(config.mcps).includes(name) ? `${name}-${Date.now()}` : name;
            config.mcps[finalName] = {
                type: 'stdio',
                command: 'npx',
                args: ['-y', withAt, ...extraArgs].filter(Boolean),
                enabled: true,
            };
            saveConfig(config);
            appendLog({
                type: 'install',
                message: 'Installed npm package',
                detail: `${pkgTrim} → ${finalName}`,
            });
            res.json({ ok: true, name: finalName });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.patch('/api/mcp/:name/tunnel-subdomain', (req, res) => {
        try {
            const { name } = req.params;
            const { tunnelSubdomain } = req.body;
            const config = loadConfig();
            const mcp = config.mcps[name];
            if (!mcp)
                return res.status(404).json({ error: 'MCP not found' });
            mcp.tunnelSubdomain =
                typeof tunnelSubdomain === 'string' && tunnelSubdomain.trim()
                    ? tunnelSubdomain.trim()
                    : undefined;
            saveConfig(config);
            appendLog({
                type: 'config',
                message: `Updated tunnel subdomain for ${name}`,
                detail: mcp.tunnelSubdomain || '(default)',
            });
            res.json({ ok: true, tunnelSubdomain: mcp.tunnelSubdomain });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.patch('/api/mcp/:name/enabled', (req, res) => {
        try {
            const { name } = req.params;
            const { enabled } = req.body;
            const config = loadConfig();
            const mcp = config.mcps[name];
            if (!mcp)
                return res.status(404).json({ error: 'MCP not found' });
            mcp.enabled = enabled;
            saveConfig(config);
            startScheduler(config);
            const action = enabled ? 'Spin up' : 'Spin down';
            appendLog({
                type: 'spin',
                message: `${action} ${name}`,
                detail: enabled ? 'MCP enabled' : 'MCP disabled',
            });
            res.json({ ok: true, enabled: mcp.enabled });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.get('/api/mcp-status', async (_req, res) => {
        try {
            const config = loadConfig();
            const entries = Object.entries(config.mcps).filter(([_, m]) => m.enabled !== false);
            const results = await Promise.all(entries.map(async ([name, mcpConfig]) => {
                const { createMcpClient } = await import('./connector.js');
                const { client, transport } = createMcpClient(name, mcpConfig);
                try {
                    const connectTimeout = mcpConfig.type === 'url'
                        ? Math.min(mcpConfig.requestTimeout ?? 12000, 12000)
                        : 8000;
                    await client.connect(transport, { timeout: connectTimeout });
                    const { tools } = await client.listTools();
                    return [name, { online: true, toolsCount: tools.length }];
                }
                catch (err) {
                    return [
                        name,
                        {
                            online: false,
                            error: err instanceof Error ? err.message : String(err),
                        },
                    ];
                }
                finally {
                    try {
                        await client.close();
                        await transport.close();
                    }
                    catch {
                        /* ignore */
                    }
                }
            }));
            const status = Object.fromEntries(results);
            res.json(status);
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.get('/api/tools', async (_req, res) => {
        try {
            const config = loadConfig();
            const toolsByMcp = {};
            for (const [name, mcpConfig] of Object.entries(config.mcps)) {
                if (mcpConfig.enabled === false)
                    continue;
                const { createMcpClient } = await import('./connector.js');
                const { client, transport } = createMcpClient(name, mcpConfig);
                try {
                    await client.connect(transport);
                    const { tools } = await client.listTools();
                    toolsByMcp[name] = tools.map((t) => ({ name: t.name, description: t.description ?? '' }));
                }
                catch (err) {
                    toolsByMcp[name] = [];
                    console.error(`MCP ${name} failed:`, err);
                }
                finally {
                    try {
                        await client.close();
                        await transport.close();
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            res.json(toolsByMcp);
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.post('/api/workflow/:name', async (req, res) => {
        try {
            const config = loadConfig();
            const name = req.params.name;
            const { stepOutputs, success } = await runWorkflow(config, name);
            appendLog({
                type: 'run',
                message: `Workflow "${name}"`,
                detail: success ? 'Completed successfully' : 'Failed',
                output: stepOutputs,
                success,
            });
            res.json({ success, stepOutputs });
        }
        catch (err) {
            const name = req.params.name;
            appendLog({
                type: 'run',
                message: `Workflow "${name}"`,
                detail: err instanceof Error ? err.message : String(err),
                success: false,
            });
            res.status(500).json({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
    app.post('/api/step', async (req, res) => {
        try {
            const { mcp, tool, args = {} } = req.body;
            if (!mcp || !tool) {
                return res.status(400).json({ error: 'mcp and tool required' });
            }
            const config = loadConfig();
            const mcpConfig = config.mcps[mcp];
            if (!mcpConfig) {
                return res.status(400).json({ error: `MCP "${mcp}" not found` });
            }
            if (mcpConfig.enabled === false) {
                return res.status(400).json({ error: `MCP "${mcp}" is disabled. Spin it up first.` });
            }
            const { createMcpClient, extractTextContent } = await import('./connector.js');
            const { client, transport } = createMcpClient(mcp, mcpConfig);
            try {
                const connectTimeout = mcpConfig.type === 'url'
                    ? mcpConfig.requestTimeout ?? 120000
                    : undefined;
                await client.connect(transport, connectTimeout ? { timeout: connectTimeout } : undefined);
                const timeout = mcpConfig.type === 'url'
                    ? mcpConfig.requestTimeout ?? 120000
                    : undefined;
                const { ensureArgsObject } = await import('./args-wrappers.js');
                const result = await client.callTool({ name: tool, arguments: ensureArgsObject(args) }, undefined, timeout ? { timeout } : undefined);
                const text = extractTextContent(result);
                res.json({
                    success: !result.isError,
                    output: text,
                    raw: result,
                });
            }
            finally {
                try {
                    await client.close();
                    await transport.close();
                }
                catch {
                    /* ignore */
                }
            }
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.get('/api/tunnel/status', (_req, res) => {
        const secureUrl = getOrchestratorTunnelUrl();
        const securePersisted = getOrchestratorTunnelPersisted();
        const tokenMcps = getTunnelTokenMcpNames();
        const baseDomain = getTunnelBaseDomain();
        const config = loadConfig();
        const mcpNames = Object.keys(config.mcps);
        const domain = baseDomain?.replace(/^\.+/, '') ?? '';
        const subdomainUrls = domain && mcpNames.length
            ? Object.fromEntries(mcpNames.map((n) => [
                n,
                `https://${toTunnelSubdomain(n, config.mcps[n])}.${domain}`,
            ]))
            : null;
        const tunnelSubdomains = Object.fromEntries(mcpNames.map((n) => [n, config.mcps[n]?.tunnelSubdomain ?? null]));
        res.json({
            secure: secureUrl ? { url: secureUrl, cloudflare: isCloudflareTunnelActive() } : null,
            securePersisted: securePersisted ? { url: securePersisted.url } : null,
            tokenMcps,
            isNamedConfigured: isNamedTunnelConfigured(),
            isCloudflareLoggedIn: isCloudflareLoggedIn(),
            baseDomain: baseDomain || null,
            subdomainUrls,
            tunnelSubdomains,
        });
    });
    app.put('/api/tunnel/domain', (req, res) => {
        try {
            const { domain } = req.body;
            const d = typeof domain === 'string' ? domain.trim() : '';
            if (!d) {
                return res.status(400).json({ error: 'domain required' });
            }
            setSecret('cloudflare_tunnel_domain', d);
            res.json({ ok: true, domain: d });
        }
        catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
    app.post('/api/tunnel/cloudflare/login', async (_req, res) => {
        try {
            const result = await runCloudflareLogin();
            res.json(result);
        }
        catch (err) {
            res.status(500).json({
                success: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });
    app.post('/api/secrets/generate', (_req, res) => {
        const token = randomBytes(32).toString('hex');
        res.json({ token });
    });
    app.get('/api/secrets/keys', (_req, res) => {
        res.json({ keys: listSecretKeys() });
    });
    app.get('/api/secrets/:key', (req, res) => {
        const { key } = req.params;
        const value = getSecret(key);
        if (value === null)
            return res.status(404).json({ error: 'Not found' });
        res.json({ key, hasValue: true });
    });
    app.put('/api/secrets/:key', (req, res) => {
        try {
            const { key } = req.params;
            const { value } = req.body;
            if (!key || typeof value !== 'string') {
                return res.status(400).json({ error: 'key and value required' });
            }
            setSecret(key, value);
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });
    app.delete('/api/secrets/:key', (req, res) => {
        const { key } = req.params;
        deleteSecret(key);
        res.json({ ok: true });
    });
    app.post('/api/tunnel/start', async (req, res) => {
        try {
            const port = Number(process.env.PORT ?? 3847);
            const config = loadConfig();
            const mcps = Object.entries(config.mcps).map(([name, cfg]) => ({ name, config: cfg }));
            const { url } = await startOrchestratorTunnel(port, { mcps });
            appendLog({ type: 'tunnel', message: 'Cloudflare tunnel started', detail: url });
            res.json({ url });
        }
        catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
    app.post('/api/tunnel/stop', (req, res) => {
        try {
            const stopped = stopOrchestratorTunnel();
            if (stopped)
                appendLog({ type: 'tunnel', message: 'Cloudflare tunnel stopped', detail: null });
            res.json({ ok: true, stopped });
        }
        catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
    app.post('/api/tunnel/token/:mcpName', (req, res) => {
        try {
            const { mcpName } = req.params;
            const config = loadConfig();
            if (!config.mcps[mcpName]) {
                return res.status(404).json({ error: `MCP "${mcpName}" not found` });
            }
            const token = generateTunnelToken();
            setTunnelToken(mcpName, token);
            const baseDomain = getTunnelBaseDomain();
            const domain = baseDomain?.replace(/^\.+/, '');
            let fullUrl = null;
            if (domain) {
                const sub = toTunnelSubdomain(mcpName, config.mcps[mcpName]);
                fullUrl = `https://${sub}.${domain}`;
            }
            else {
                const baseUrl = getOrchestratorTunnelUrl() ?? getOrchestratorTunnelPersisted()?.url;
                if (baseUrl)
                    fullUrl = `${baseUrl}/tunnel/${encodeURIComponent(mcpName)}`;
            }
            appendLog({ type: 'tunnel', message: `Token generated for ${mcpName}`, detail: null });
            res.json({ mcpName, token, fullUrl });
        }
        catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
    app.delete('/api/tunnel/token/:mcpName', (req, res) => {
        try {
            const { mcpName } = req.params;
            deleteTunnelToken(mcpName);
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
    app.post('/mcp', async (req, res) => {
        const { handleMcpRequest } = await import('./mcp-server.js');
        await handleMcpRequest(req, res, req.body);
    });
    app.get('/mcp', async (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        if (!sessionId) {
            res.status(400).send('Missing mcp-session-id header');
            return;
        }
        const { handleMcpRequest } = await import('./mcp-server.js');
        await handleMcpRequest(req, res);
    });
    app.delete('/mcp', async (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        if (!sessionId) {
            res.status(400).send('Missing mcp-session-id header');
            return;
        }
        const { handleMcpRequest } = await import('./mcp-server.js');
        await handleMcpRequest(req, res);
    });
    app.use(express.static(path.join(__dirname, '../public')));
    app.get('*', (_req, res) => {
        res.sendFile(path.join(__dirname, '../public/index.html'));
    });
    startScheduler(loadConfig());
    const port = process.env.PORT ?? 3847;
    app.listen(port, () => {
        console.log(`MCP Orchestrator UI → http://localhost:${port}`);
        console.log(`  Also: http://mcporch.local:${port} (if hosts configured)`);
    });
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
