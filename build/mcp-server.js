import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWorkflow } from './workflow.js';
import { loadConfig, saveConfig } from './config-loader.js';
import { appendLog, getLogs, clearLogs } from './logs.js';
import { startScheduler } from './scheduler.js';
import { createMcpClient, extractTextContent } from './connector.js';
import { ensureArgsObject } from './args-wrappers.js';
import { toTunnelSubdomain } from './config.js';
import { startOrchestratorTunnel, stopOrchestratorTunnel, getOrchestratorTunnelUrl, getOrchestratorTunnelPersisted, isCloudflareTunnelActive, isNamedTunnelConfigured, isCloudflareLoggedIn, runCloudflareLogin, getTunnelBaseDomain, } from './tunnel.js';
import { setSecret } from './secrets.js';
import { getTunnelTokenMcpNames, setTunnelToken, deleteTunnelToken, generateTunnelToken, } from './tunnel-tokens.js';
import { registerProxiedTools } from './mcp-proxy-tools.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_BASE = 'https://prod.registry.modelcontextprotocol.io';
const sessions = new Map();
const WorkflowStepSchema = z.object({
    mcp: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
    mapOutputFrom: z.number().optional(),
});
async function createMcpServer() {
    const server = new McpServer({
        name: 'porch',
        version: '0.1.0',
    }, { capabilities: { logging: {} } });
    server.registerTool('list_workflows', {
        title: 'List Workflows',
        description: 'List all configured workflows. Use this to see which workflows are available before running one.',
        inputSchema: {},
    }, async () => {
        const config = loadConfig();
        const list = config.workflows.map((w) => ({
            name: w.name,
            description: w.description || '(no description)',
            steps: w.steps.length,
        }));
        return {
            content: [
                {
                    type: 'text',
                    text: list.length === 0
                        ? 'No workflows configured. Add workflows in the MCP Orchestrator UI.'
                        : JSON.stringify(list, null, 2),
                },
            ],
        };
    });
    server.registerTool('run_workflow', {
        title: 'Run Workflow',
        description: 'Execute a workflow by name. Use list_workflows first to see available workflows. Pass input to substitute {{input.key}} placeholders in workflow steps.',
        inputSchema: {
            name: z.string().describe('The exact name of the workflow to run'),
            input: z
                .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
                .optional()
                .describe('Input for {{input.key}} placeholders (e.g. { subject: "math" } or ["a","b"] for {{input.0}})'),
        },
    }, async ({ name, input }) => {
        const config = loadConfig();
        try {
            const { stepOutputs, success } = await runWorkflow(config, name, input);
            appendLog({
                type: 'run',
                message: `Workflow "${name}" (via MCP)`,
                detail: success ? 'Completed successfully' : 'Failed',
                output: stepOutputs,
                success,
            });
            const output = stepOutputs.length > 0 ? stepOutputs[stepOutputs.length - 1] : '(no output)';
            return {
                content: [
                    {
                        type: 'text',
                        text: success
                            ? `Workflow "${name}" completed successfully.\n\nOutput:\n${output}`
                            : `Workflow "${name}" failed.\n\nOutput:\n${output}`,
                    },
                ],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendLog({
                type: 'run',
                message: `Workflow "${name}" (via MCP)`,
                detail: msg,
                success: false,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: ${msg}`,
                    },
                ],
                isError: true,
            };
        }
    });
    // --- Phase 1: Workflow Management ---
    server.registerTool('get_workflow', {
        title: 'Get Workflow',
        description: 'Get full workflow details by name. When fixing or modifying workflows, fetch orchestrator://workflow-guide first for placeholder syntax and troubleshooting.',
        inputSchema: { name: z.string().describe('Workflow name') },
    }, async ({ name }) => {
        const config = loadConfig();
        const w = config.workflows.find((x) => x.name === name || x.name.toLowerCase() === name.toLowerCase());
        if (!w)
            return { content: [{ type: 'text', text: `Workflow not found: ${name}` }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(w, null, 2) }] };
    });
    server.registerTool('add_workflow', {
        title: 'Add Workflow',
        description: 'Create a new workflow. Before creating, fetch orchestrator://workflow-guide for placeholders, output inspection, and common pitfalls.',
        inputSchema: {
            name: z.string(),
            description: z.string().optional(),
            steps: z.array(WorkflowStepSchema),
            trigger: z.enum(['manual', 'schedule']).optional(),
            schedule: z.string().optional(),
        },
    }, async ({ name, description, steps, trigger, schedule }) => {
        const config = loadConfig();
        if (config.workflows.some((w) => w.name === name)) {
            return { content: [{ type: 'text', text: `Workflow "${name}" already exists` }], isError: true };
        }
        const w = { name, description, steps: steps, trigger: trigger ?? 'manual', schedule };
        config.workflows.push(w);
        saveConfig(config);
        startScheduler(config);
        appendLog({ type: 'config', message: `Added workflow "${name}"`, detail: null, success: true });
        return { content: [{ type: 'text', text: `Workflow "${name}" created.` }] };
    });
    server.registerTool('update_workflow', {
        title: 'Update Workflow',
        description: 'Update a workflow by name (partial update). Before editing, fetch orchestrator://workflow-guide for placeholder syntax and troubleshooting.',
        inputSchema: {
            name: z.string(),
            description: z.string().optional(),
            steps: z.array(WorkflowStepSchema).optional(),
            trigger: z.enum(['manual', 'schedule']).optional(),
            schedule: z.string().optional(),
        },
    }, async ({ name, description, steps, trigger, schedule }) => {
        const config = loadConfig();
        const idx = config.workflows.findIndex((w) => w.name === name || w.name.toLowerCase() === name.toLowerCase());
        if (idx < 0)
            return { content: [{ type: 'text', text: `Workflow not found: ${name}` }], isError: true };
        const w = config.workflows[idx];
        if (description !== undefined)
            w.description = description;
        if (steps !== undefined)
            w.steps = steps;
        if (trigger !== undefined)
            w.trigger = trigger;
        if (schedule !== undefined)
            w.schedule = schedule;
        saveConfig(config);
        startScheduler(config);
        appendLog({ type: 'config', message: `Updated workflow "${name}"`, detail: null, success: true });
        return { content: [{ type: 'text', text: `Workflow "${name}" updated.` }] };
    });
    server.registerTool('delete_workflow', {
        title: 'Delete Workflow',
        description: 'Delete a workflow by name.',
        inputSchema: { name: z.string() },
    }, async ({ name }) => {
        const config = loadConfig();
        const idx = config.workflows.findIndex((w) => w.name === name || w.name.toLowerCase() === name.toLowerCase());
        if (idx < 0)
            return { content: [{ type: 'text', text: `Workflow not found: ${name}` }], isError: true };
        config.workflows.splice(idx, 1);
        saveConfig(config);
        startScheduler(config);
        appendLog({ type: 'config', message: `Deleted workflow "${name}"`, detail: null, success: true });
        return { content: [{ type: 'text', text: `Workflow "${name}" deleted.` }] };
    });
    server.registerTool('schedule_workflow', {
        title: 'Schedule Workflow',
        description: 'Set a workflow to run on a cron schedule.',
        inputSchema: { name: z.string(), schedule: z.string().describe('Cron expression (e.g. "*/30 * * * *" for every 30 min)') },
    }, async ({ name, schedule }) => {
        const config = loadConfig();
        const w = config.workflows.find((x) => x.name === name || x.name.toLowerCase() === name.toLowerCase());
        if (!w)
            return { content: [{ type: 'text', text: `Workflow not found: ${name}` }], isError: true };
        w.trigger = 'schedule';
        w.schedule = schedule.trim();
        saveConfig(config);
        startScheduler(config);
        appendLog({ type: 'config', message: `Scheduled workflow "${name}"`, detail: schedule, success: true });
        return { content: [{ type: 'text', text: `Workflow "${name}" scheduled: ${schedule}` }] };
    });
    server.registerTool('unschedule_workflow', {
        title: 'Unschedule Workflow',
        description: 'Set a workflow to manual-only (remove schedule).',
        inputSchema: { name: z.string() },
    }, async ({ name }) => {
        const config = loadConfig();
        const w = config.workflows.find((x) => x.name === name || x.name.toLowerCase() === name.toLowerCase());
        if (!w)
            return { content: [{ type: 'text', text: `Workflow not found: ${name}` }], isError: true };
        w.trigger = 'manual';
        w.schedule = '';
        saveConfig(config);
        startScheduler(config);
        appendLog({ type: 'config', message: `Unscheduled workflow "${name}"`, detail: null, success: true });
        return { content: [{ type: 'text', text: `Workflow "${name}" is now manual-only.` }] };
    });
    // --- Phase 2: MCP Connection Management ---
    server.registerTool('list_mcps', {
        title: 'List MCPs',
        description: 'List configured MCPs with enabled status and type.',
        inputSchema: {},
    }, async () => {
        const config = loadConfig();
        const list = Object.entries(config.mcps).map(([name, m]) => ({
            name,
            type: m.type,
            enabled: m.enabled !== false,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    });
    server.registerTool('get_mcp_status', {
        title: 'Get MCP Status',
        description: 'Health check: connect to each enabled MCP and report online/offline.',
        inputSchema: {},
    }, async () => {
        const config = loadConfig();
        const entries = Object.entries(config.mcps).filter(([, m]) => m.enabled !== false);
        const results = {};
        for (const [name, mcpConfig] of entries) {
            try {
                const { client, transport } = createMcpClient(name, mcpConfig);
                const timeout = mcpConfig.type === 'url'
                    ? Math.min(mcpConfig.requestTimeout ?? 12000, 12000)
                    : 8000;
                await client.connect(transport, { timeout });
                const { tools } = await client.listTools();
                results[name] = { online: true, toolsCount: tools.length };
                await client.close();
                await transport.close();
            }
            catch (err) {
                results[name] = { online: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    });
    server.registerTool('add_mcp', {
        title: 'Add MCP',
        description: 'Add an MCP connection. Use type stdio (command+args) or url (url+optional token).',
        inputSchema: {
            name: z.string(),
            type: z.enum(['stdio', 'url']),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            cwd: z.string().optional(),
            url: z.string().optional(),
            authorizationToken: z.string().optional(),
            enabled: z.boolean().optional(),
        },
    }, async (args) => {
        const config = loadConfig();
        const { name, type, enabled = true } = args;
        if (config.mcps[name]) {
            return { content: [{ type: 'text', text: `MCP "${name}" already exists` }], isError: true };
        }
        let mcpConfig;
        if (type === 'stdio') {
            const command = args.command ?? 'npx';
            const mcpArgs = args.args ?? [];
            mcpConfig = { type: 'stdio', command, args: mcpArgs, cwd: args.cwd, enabled };
        }
        else {
            const url = args.url;
            if (!url)
                return { content: [{ type: 'text', text: 'url required for type url' }], isError: true };
            mcpConfig = { type: 'url', url, authorizationToken: args.authorizationToken, enabled };
        }
        config.mcps[name] = mcpConfig;
        saveConfig(config);
        appendLog({ type: 'install', message: `Added MCP "${name}"`, detail: type, success: true });
        return { content: [{ type: 'text', text: `MCP "${name}" added.` }] };
    });
    server.registerTool('remove_mcp', {
        title: 'Remove MCP',
        description: 'Remove an MCP by name. Fails if workflows reference it.',
        inputSchema: { name: z.string() },
    }, async ({ name }) => {
        const config = loadConfig();
        if (!config.mcps[name]) {
            return { content: [{ type: 'text', text: `MCP "${name}" not found` }], isError: true };
        }
        const usedBy = config.workflows.filter((w) => w.steps.some((s) => s.mcp === name));
        if (usedBy.length > 0) {
            return {
                content: [{ type: 'text', text: `Cannot remove: workflow(s) "${usedBy.map((w) => w.name).join(', ')}" use "${name}". Remove or update those workflows first.` }],
                isError: true,
            };
        }
        delete config.mcps[name];
        saveConfig(config);
        appendLog({ type: 'config', message: `Removed MCP "${name}"`, detail: null, success: true });
        return { content: [{ type: 'text', text: `MCP "${name}" removed.` }] };
    });
    server.registerTool('enable_mcp', {
        title: 'Enable MCP',
        description: 'Set MCP enabled (spin up).',
        inputSchema: { name: z.string() },
    }, async ({ name }) => {
        const config = loadConfig();
        const mcp = config.mcps[name];
        if (!mcp)
            return { content: [{ type: 'text', text: `MCP "${name}" not found` }], isError: true };
        mcp.enabled = true;
        saveConfig(config);
        startScheduler(config);
        appendLog({ type: 'spin', message: `Enabled ${name}`, detail: null, success: true });
        return { content: [{ type: 'text', text: `MCP "${name}" enabled.` }] };
    });
    server.registerTool('disable_mcp', {
        title: 'Disable MCP',
        description: 'Set MCP disabled (spin down).',
        inputSchema: { name: z.string() },
    }, async ({ name }) => {
        const config = loadConfig();
        const mcp = config.mcps[name];
        if (!mcp)
            return { content: [{ type: 'text', text: `MCP "${name}" not found` }], isError: true };
        mcp.enabled = false;
        saveConfig(config);
        startScheduler(config);
        appendLog({ type: 'spin', message: `Disabled ${name}`, detail: null, success: true });
        return { content: [{ type: 'text', text: `MCP "${name}" disabled.` }] };
    });
    server.registerTool('call_tool', {
        title: 'Call Tool',
        description: 'Call a tool on an MCP by name. Use when the proxied tool (mcpName__toolName) is not available or you need to specify mcp/tool explicitly.',
        inputSchema: {
            mcp: z.string(),
            tool: z.string(),
            args: z.record(z.string(), z.unknown()).optional(),
        },
    }, async ({ mcp, tool, args = {} }) => {
        const config = loadConfig();
        const mcpConfig = config.mcps[mcp];
        if (!mcpConfig)
            return { content: [{ type: 'text', text: `MCP "${mcp}" not found` }], isError: true };
        if (mcpConfig.enabled === false) {
            return { content: [{ type: 'text', text: `MCP "${mcp}" is disabled. Enable it first.` }], isError: true };
        }
        const { client, transport } = createMcpClient(mcp, mcpConfig);
        try {
            const timeout = mcpConfig.type === 'url'
                ? mcpConfig.requestTimeout ?? 120000
                : undefined;
            await client.connect(transport, timeout ? { timeout } : undefined);
            const result = await client.callTool({ name: tool, arguments: ensureArgsObject(args) }, undefined, timeout ? { timeout } : undefined);
            const text = extractTextContent(result);
            return {
                content: [{ type: 'text', text: result.isError ? `Error: ${text}` : text }],
                isError: Boolean(result.isError),
            };
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
    });
    server.registerTool('list_tools', {
        title: 'List Tools',
        description: 'List tools available per MCP.',
        inputSchema: { mcp: z.string().optional().describe('If omitted, list all MCPs') },
    }, async ({ mcp }) => {
        const config = loadConfig();
        const entries = mcp
            ? Object.entries(config.mcps).filter(([n]) => n === mcp)
            : Object.entries(config.mcps).filter(([, m]) => m.enabled !== false);
        const out = {};
        for (const [name, mcpConfig] of entries) {
            if (mcpConfig.enabled === false)
                continue;
            try {
                const { client, transport } = createMcpClient(name, mcpConfig);
                await client.connect(transport);
                const { tools } = await client.listTools();
                out[name] = tools.map((t) => ({ name: t.name, description: t.description ?? '' }));
                await client.close();
                await transport.close();
            }
            catch {
                out[name] = [];
            }
        }
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    });
    // --- Phase 3: Tunnel ---
    server.registerTool('get_tunnel_status', {
        title: 'Get Tunnel Status',
        description: 'Return tunnel status: active, URLs, base domain, token MCPs.',
        inputSchema: {},
    }, async () => {
        const active = isCloudflareTunnelActive();
        const secureUrl = getOrchestratorTunnelUrl();
        const securePersisted = getOrchestratorTunnelPersisted();
        const tokenMcps = getTunnelTokenMcpNames();
        const baseDomain = getTunnelBaseDomain();
        const config = loadConfig();
        const domain = baseDomain?.replace(/^\.+/, '') ?? '';
        const subdomainUrls = domain && Object.keys(config.mcps).length
            ? Object.fromEntries(Object.keys(config.mcps).map((n) => [
                n,
                `https://${toTunnelSubdomain(n, config.mcps[n])}.${domain}`,
            ]))
            : null;
        const obj = {
            active,
            secureUrl: secureUrl ?? null,
            securePersisted: securePersisted ? { url: securePersisted.url } : null,
            tokenMcps,
            isNamedConfigured: isNamedTunnelConfigured(),
            isCloudflareLoggedIn: isCloudflareLoggedIn(),
            baseDomain: baseDomain ?? null,
            subdomainUrls,
        };
        return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
    });
    server.registerTool('start_tunnel', {
        title: 'Start Tunnel',
        description: 'Start the Cloudflare tunnel.',
        inputSchema: {},
    }, async () => {
        const port = Number(process.env.PORT ?? 3847);
        const config = loadConfig();
        const mcps = Object.entries(config.mcps).map(([name, cfg]) => ({ name, config: cfg }));
        const { url } = await startOrchestratorTunnel(port, { mcps });
        appendLog({ type: 'tunnel', message: 'Cloudflare tunnel started', detail: url, success: true });
        return { content: [{ type: 'text', text: `Tunnel started: ${url}` }] };
    });
    server.registerTool('stop_tunnel', {
        title: 'Stop Tunnel',
        description: 'Stop the Cloudflare tunnel.',
        inputSchema: {},
    }, async () => {
        const stopped = stopOrchestratorTunnel();
        if (stopped)
            appendLog({ type: 'tunnel', message: 'Cloudflare tunnel stopped', detail: null, success: true });
        return { content: [{ type: 'text', text: stopped ? 'Tunnel stopped.' : 'Tunnel was not running.' }] };
    });
    server.registerTool('set_tunnel_domain', {
        title: 'Set Tunnel Domain',
        description: 'Set base domain for named tunnel (e.g. mcp.example.com).',
        inputSchema: { domain: z.string() },
    }, async ({ domain }) => {
        const d = domain.trim();
        if (!d)
            return { content: [{ type: 'text', text: 'domain required' }], isError: true };
        setSecret('cloudflare_tunnel_domain', d);
        appendLog({ type: 'config', message: 'Set tunnel domain', detail: d, success: true });
        return { content: [{ type: 'text', text: `Tunnel domain set to ${d}` }] };
    });
    server.registerTool('cloudflare_login', {
        title: 'Cloudflare Login',
        description: 'Run Cloudflare login (opens browser for OAuth).',
        inputSchema: {},
    }, async () => {
        const result = await runCloudflareLogin();
        return {
            content: [{ type: 'text', text: result.success ? result.message : `Failed: ${result.message}` }],
            isError: !result.success,
        };
    });
    server.registerTool('generate_tunnel_token', {
        title: 'Generate Tunnel Token',
        description: 'Generate a token for an MCP; returns token and public URL.',
        inputSchema: { mcpName: z.string() },
    }, async ({ mcpName }) => {
        const config = loadConfig();
        if (!config.mcps[mcpName]) {
            return { content: [{ type: 'text', text: `MCP "${mcpName}" not found` }], isError: true };
        }
        const token = generateTunnelToken();
        setTunnelToken(mcpName, token);
        const domain = getTunnelBaseDomain()?.replace(/^\.+/, '');
        let fullUrl;
        if (domain) {
            const sub = toTunnelSubdomain(mcpName, config.mcps[mcpName]);
            fullUrl = `https://${sub}.${domain}`;
        }
        else {
            const base = getOrchestratorTunnelUrl() ?? getOrchestratorTunnelPersisted()?.url;
            fullUrl = base ? `${base}/tunnel/${encodeURIComponent(mcpName)}` : '(start tunnel first for URL)';
        }
        appendLog({ type: 'tunnel', message: `Token generated for ${mcpName}`, detail: null, success: true });
        return { content: [{ type: 'text', text: JSON.stringify({ mcpName, token, fullUrl }, null, 2) }] };
    });
    server.registerTool('revoke_tunnel_token', {
        title: 'Revoke Tunnel Token',
        description: 'Revoke the tunnel token for an MCP.',
        inputSchema: { mcpName: z.string() },
    }, async ({ mcpName }) => {
        deleteTunnelToken(mcpName);
        appendLog({ type: 'tunnel', message: `Token revoked for ${mcpName}`, detail: null, success: true });
        return { content: [{ type: 'text', text: `Token revoked for ${mcpName}.` }] };
    });
    // --- Phase 4: Registry + NPM ---
    server.registerTool('search_registry', {
        title: 'Search Registry',
        description: 'Search the MCP registry for servers.',
        inputSchema: {
            search: z.string().optional(),
            cursor: z.string().optional(),
            limit: z.string().optional(),
        },
    }, async ({ search, cursor, limit = '20' }) => {
        const params = new URLSearchParams();
        if (cursor)
            params.set('cursor', cursor);
        params.set('limit', limit);
        if (search)
            params.set('search', search);
        const r = await fetch(`${REGISTRY_BASE}/v0.1/servers?${params}`);
        if (!r.ok)
            throw new Error(`Registry: ${r.status}`);
        const data = await r.json();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    });
    server.registerTool('install_from_registry', {
        title: 'Install From Registry',
        description: 'Install an MCP from the registry. Pass the server object from search_registry. For MCPs that need env vars (e.g. API_ID, API_HASH), pass env as well.',
        inputSchema: {
            server: z.record(z.string(), z.unknown()).describe('Server object from registry (or { server: {...} })'),
            env: z.record(z.string(), z.string()).optional().describe('Optional env vars, e.g. { API_ID: "123", API_HASH: "secret:key" }'),
        },
    }, async ({ server: serverArg, env: envOverrides }) => {
        const serverDetail = (serverArg && typeof serverArg === 'object' && 'server' in serverArg
            ? serverArg.server
            : serverArg);
        if (!serverDetail?.name) {
            return { content: [{ type: 'text', text: 'Missing server data (need name)' }], isError: true };
        }
        const displayName = serverDetail.title || serverDetail.name.split('/').pop() || serverDetail.name;
        const config = loadConfig();
        const toFinalName = (base) => {
            const name = base.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');
            return Object.keys(config.mcps).includes(name) ? `${name}-${Date.now()}` : name;
        };
        if (serverDetail.remotes?.length) {
            const remote = serverDetail.remotes[0];
            if (remote.type === 'streamable-http' || remote.type === 'sse') {
                const finalName = toFinalName(displayName);
                config.mcps[finalName] = { type: 'url', url: remote.url, enabled: true };
                saveConfig(config);
                appendLog({ type: 'install', message: 'Installed from registry', detail: `${displayName} → ${finalName}`, success: true });
                return { content: [{ type: 'text', text: `Installed: ${finalName}` }] };
            }
        }
        if (serverDetail.packages?.length) {
            const npmPkg = serverDetail.packages.find((p) => p.registryType === 'npm' && p.transport?.type === 'stdio');
            const pypiPkg = serverDetail.packages.find((p) => p.registryType === 'pypi' && p.transport?.type === 'stdio');
            if (npmPkg) {
                const ver = npmPkg.version && npmPkg.version !== 'latest' ? `@${npmPkg.version}` : '';
                const id = npmPkg.identifier + ver;
                const hint = npmPkg.runtimeHint || 'npx';
                const runtimeArgs = Array.isArray(npmPkg.runtimeArguments) ? npmPkg.runtimeArguments.map((a) => String(typeof a === 'object' && a && 'value' in a ? a.value : a)) : ['-y'];
                const pkgArgs = Array.isArray(npmPkg.packageArguments) ? npmPkg.packageArguments.map((a) => String(typeof a === 'object' && a && 'value' in a ? a.value : a)) : [];
                const args = [...runtimeArgs, id, ...pkgArgs].filter(Boolean);
                const command = hint === 'npx' ? 'npx' : hint;
                const finalName = toFinalName(displayName);
                config.mcps[finalName] = {
                    type: 'stdio',
                    command,
                    args,
                    enabled: true,
                    ...(envOverrides && Object.keys(envOverrides).length ? { env: envOverrides } : {}),
                };
                saveConfig(config);
                appendLog({ type: 'install', message: 'Installed from registry', detail: `${displayName} → ${finalName}`, success: true });
                return { content: [{ type: 'text', text: `Installed: ${finalName}` }] };
            }
            if (pypiPkg) {
                const identifier = pypiPkg.identifier;
                const ver = pypiPkg.version && pypiPkg.version !== 'latest' ? `==${pypiPkg.version}` : '';
                const pkgSpec = identifier + ver;
                const pkgArgs = Array.isArray(pypiPkg.packageArguments)
                    ? pypiPkg.packageArguments.map((a) => String(typeof a === 'object' && a && 'value' in a ? a.value : a))
                    : [];
                const command = 'uvx';
                const args = [pkgSpec, ...pkgArgs].filter(Boolean);
                const finalName = toFinalName(displayName);
                config.mcps[finalName] = {
                    type: 'stdio',
                    command,
                    args,
                    enabled: true,
                    ...(envOverrides && Object.keys(envOverrides).length ? { env: envOverrides } : {}),
                };
                saveConfig(config);
                appendLog({ type: 'install', message: 'Installed from registry', detail: `${displayName} → ${finalName}`, success: true });
                return { content: [{ type: 'text', text: `Installed: ${finalName}` }] };
            }
        }
        return { content: [{ type: 'text', text: 'No supported package or remote transport found' }], isError: true };
    });
    server.registerTool('install_npm_mcp', {
        title: 'Install NPM MCP',
        description: 'Install an stdio MCP from npm.',
        inputSchema: {
            package: z.string().describe('npm package (e.g. @modelcontextprotocol/server-filesystem)'),
            args: z.array(z.string()).optional(),
        },
    }, async ({ package: pkg, args: extraArgs = [] }) => {
        const pkgTrim = (pkg || '').trim();
        if (!/^@?[\w.-]+\/[\w.-]+$/.test(pkgTrim.replace(/^@/, ''))) {
            return { content: [{ type: 'text', text: 'Invalid npm package. Use format: @org/package or org/package' }], isError: true };
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
        appendLog({ type: 'install', message: 'Installed npm package', detail: `${pkgTrim} → ${finalName}`, success: true });
        return { content: [{ type: 'text', text: `Installed: ${finalName}` }] };
    });
    // --- Phase 5: Config, Logs ---
    server.registerTool('get_config', {
        title: 'Get Config',
        description: 'Return current config (mcps, workflows) as JSON.',
        inputSchema: {},
    }, async () => {
        const config = loadConfig();
        return { content: [{ type: 'text', text: JSON.stringify(config, null, 2) }] };
    });
    server.registerTool('get_logs', {
        title: 'Get Logs',
        description: 'Return recent logs.',
        inputSchema: { limit: z.number().optional().describe('Max entries (default 50)') },
    }, async ({ limit = 50 }) => {
        const logs = getLogs().slice(0, limit);
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
    });
    server.registerTool('clear_logs', {
        title: 'Clear Logs',
        description: 'Clear all logs.',
        inputSchema: {},
    }, async () => {
        clearLogs();
        appendLog({ type: 'config', message: 'Logs cleared', detail: null, success: true });
        return { content: [{ type: 'text', text: 'Logs cleared.' }] };
    });
    // --- Phase 6+7: Resources ---
    registerResources(server);
    // --- Proxied MCP tools: expose each MCP's tools as mcpName__toolName for direct use ---
    await registerProxiedTools(server);
    return server;
}
function registerResources(server) {
    const configResource = () => {
        const c = loadConfig();
        return { contents: [{ uri: 'orchestrator://config', mimeType: 'application/json', text: JSON.stringify(c, null, 2) }] };
    };
    server.registerResource('config', 'orchestrator://config', { mimeType: 'application/json', description: 'Full orchestrator config (mcps, workflows)' }, () => Promise.resolve(configResource()));
    const statusResource = async () => {
        const config = loadConfig();
        const entries = Object.entries(config.mcps).filter(([, m]) => m.enabled !== false);
        const results = {};
        for (const [name, mcpConfig] of entries) {
            try {
                const { client, transport } = createMcpClient(name, mcpConfig);
                await client.connect(transport, { timeout: 8000 });
                const { tools } = await client.listTools();
                results[name] = { online: true, toolsCount: tools.length };
                await client.close();
                await transport.close();
            }
            catch (err) {
                results[name] = { online: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
        const tunnelActive = isCloudflareTunnelActive();
        const tunnelUrl = getOrchestratorTunnelUrl();
        return {
            contents: [{
                    uri: 'orchestrator://status',
                    mimeType: 'application/json',
                    text: JSON.stringify({ mcps: results, tunnel: { active: tunnelActive, url: tunnelUrl } }, null, 2),
                }],
        };
    };
    server.registerResource('status', 'orchestrator://status', { mimeType: 'application/json', description: 'MCP status and tunnel status' }, statusResource);
    const logsResource = () => {
        const logs = getLogs().slice(0, 100);
        return { contents: [{ uri: 'orchestrator://logs', mimeType: 'application/json', text: JSON.stringify(logs, null, 2) }] };
    };
    server.registerResource('logs', 'orchestrator://logs', { mimeType: 'application/json', description: 'Recent logs' }, () => Promise.resolve(logsResource()));
    const glossaryPath = path.join(__dirname, '../docs/glossary.md');
    const glossaryContent = fs.existsSync(glossaryPath)
        ? fs.readFileSync(glossaryPath, 'utf8')
        : getBuiltInGlossary();
    server.registerResource('glossary', 'orchestrator://glossary', {
        mimeType: 'text/markdown',
        description: 'Read this first: reference for every MCP Orchestrator tool—args, usage, examples',
    }, () => Promise.resolve({ contents: [{ uri: 'orchestrator://glossary', mimeType: 'text/markdown', text: glossaryContent }] }));
    const workflowGuidePath = path.join(__dirname, '../docs/creating-workflows.md');
    const workflowGuideContent = fs.existsSync(workflowGuidePath)
        ? fs.readFileSync(workflowGuidePath, 'utf8')
        : 'Workflow guide not found. See docs/creating-workflows.md in the repo.';
    server.registerResource('workflow-guide', 'orchestrator://workflow-guide', {
        mimeType: 'text/markdown',
        description: 'Read this before creating or editing workflows. Covers placeholders (regex vs JSON path), output inspection, and real troubleshooting examples.',
    }, () => Promise.resolve({
        contents: [{ uri: 'orchestrator://workflow-guide', mimeType: 'text/markdown', text: workflowGuideContent }],
    }));
}
function getBuiltInGlossary() {
    return `# MCP Orchestrator Tools — Glossary

Read this to understand every tool and how to use it.

## Overview

The MCP Orchestrator connects MCPs locally (stdio or URL), runs workflows that chain tools across MCPs, and can expose MCPs publicly via Cloudflare tunnel. **You can use MCPs directly** — no workflow required.

## Direct MCP Access

Each MCP's tools are exposed as \`mcpName__toolName\` (e.g. \`spotify__getNowPlaying\`, \`pieces__create_pieces_memory\`). Call these directly. Use \`call_tool\` when you need to specify mcp/tool explicitly.

## Quick Start

1. \`list_mcps\` — See configured MCPs
2. \`get_mcp_status\` — Check which MCPs are online
3. \`list_workflows\` — See workflows
4. \`run_workflow\` — Run one by name
5. **Direct tools** — Call \`spotify__getNowPlaying\`, \`pieces__create_pieces_memory\`, etc.

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

**Workflow steps:** \`{ mcp: string, tool: string, args?: object }\`. Placeholders: \`{{step0}}\`, \`{{step1.id}}\`, \`{{step1.playlists[1].id}}\` (nested + array index), \`{{step1:regex:pat}}\`, \`{{step0:regexAll:pat}}\`, \`{{input.key}}\` (from run_workflow input), \`{{date.now}}\`, \`{{date.isoDate}}\`, \`{{date.isoTime}}\`, \`{{date.isoDateTime}}\`, \`{{date.timestamp}}\`, \`{{uuid}}\`, \`{{date.year}}\`, \`{{date.month}}\`, \`{{date.day}}\`, \`{{date.weekday}}\`, \`{{js: expression }}\`.

## MCP Connection Management

| Tool | Purpose | Key Args |
|------|---------|----------|
| list_mcps | List MCPs | (none) |
| get_mcp_status | Health check | (none) |
| add_mcp | Add MCP | name, type (stdio|url), command?, args?, url?, authorizationToken? |
| remove_mcp | Remove MCP | name (fails if workflows use it) |
| enable_mcp | Spin up | name |
| disable_mcp | Spin down | name |
| call_tool | Call a tool by mcp/tool/args | mcp, tool, args? |
| list_tools | List tools per MCP | mcp? (omit for all) |

**Gateway mode (default):** Each MCP exposes \`mcpName__call\` (or \`prefix__call\`). Use \`list_tools\` to discover, then \`spotify__call(tool, args)\`. Set \`proxyMode: "full"\` for legacy \`mcpName__toolName\` per-tool proxying.

**Gotcha:** MCP must be enabled. Use \`enable_mcp\` first if disabled.

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
| orchestrator://workflow-guide | Resource: workflow creation guide |
`;
}
function isInitializeRequest(body) {
    if (body && typeof body === 'object' && 'method' in body) {
        return body.method === 'initialize';
    }
    return false;
}
export async function handleMcpRequest(req, res, parsedBody) {
    const sessionId = req.headers['mcp-session-id'];
    try {
        let transport;
        if (sessionId && sessions.has(sessionId)) {
            transport = sessions.get(sessionId).transport;
        }
        else if (!sessionId && parsedBody && isInitializeRequest(parsedBody)) {
            const server = await createMcpServer();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    if (sid)
                        sessions.set(sid, { server, transport });
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid)
                    sessions.delete(sid);
            };
            await server.connect(transport);
        }
        else {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID. Send initialize first.' },
                id: null,
            }));
            return;
        }
        await transport.handleRequest(req, res, parsedBody);
    }
    catch (error) {
        console.error('MCP request error:', error);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            }));
        }
    }
}
