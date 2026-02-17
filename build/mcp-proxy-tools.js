/**
 * Fetches tools from configured MCPs and registers them as proxied tools
 * (mcpName__toolName) so clients can call them directly without using call_tool.
 */
import * as z from 'zod/v4';
import { loadConfig } from './config-loader.js';
import { createMcpClient, extractTextContent } from './connector.js';
import { ensureArgsObject } from './args-wrappers.js';
import { proxyToolsCache, setProxyToolsCache } from './proxy-tools-cache.js';
const PROXY_SEP = '__';
export { invalidateProxyToolsCache } from './proxy-tools-cache.js';
export async function fetchProxiedTools() {
    if (proxyToolsCache)
        return proxyToolsCache;
    const config = loadConfig();
    const tools = [];
    for (const [mcpName, mcpConfig] of Object.entries(config.mcps)) {
        if (mcpConfig.enabled === false)
            continue;
        try {
            const { client, transport } = createMcpClient(mcpName, mcpConfig);
            const timeout = mcpConfig.type === 'url'
                ? mcpConfig.requestTimeout ?? 120000
                : undefined;
            await client.connect(transport, timeout ? { timeout } : undefined);
            const { tools: mcpTools } = await client.listTools();
            await client.close();
            await transport.close();
            for (const t of mcpTools) {
                tools.push({
                    proxyName: `${mcpName}${PROXY_SEP}${t.name}`,
                    mcpName,
                    toolName: t.name,
                    title: t.title ?? t.name,
                    description: `[${mcpName}] ${t.description ?? t.name}`,
                    inputSchema: t.inputSchema ?? {},
                });
            }
        }
        catch {
        }
    }
    setProxyToolsCache(tools);
    return tools;
}
export function isProxyToolName(name) {
    return name.includes(PROXY_SEP);
}
export function parseProxyToolName(name) {
    const idx = name.indexOf(PROXY_SEP);
    if (idx < 0)
        return null;
    return {
        mcp: name.slice(0, idx),
        tool: name.slice(idx + PROXY_SEP.length),
    };
}
export async function registerProxiedTools(server) {
    const config = loadConfig();
    const proxiedTools = await fetchProxiedTools();
    for (const { proxyName, mcpName, toolName, title, description, inputSchema } of proxiedTools) {
        const mcpConfig = config.mcps[mcpName];
        if (!mcpConfig || mcpConfig.enabled === false)
            continue;
        server.registerTool(proxyName, {
            title,
            description,
            inputSchema: z.record(z.string(), z.unknown()),
        }, async (args) => {
            const mcpCfg = loadConfig().mcps[mcpName];
            if (!mcpCfg) {
                return {
                    content: [{ type: 'text', text: `MCP "${mcpName}" not found` }],
                    isError: true,
                };
            }
            if (mcpCfg.enabled === false) {
                return {
                    content: [{ type: 'text', text: `MCP "${mcpName}" is disabled. Enable it first.` }],
                    isError: true,
                };
            }
            const { client, transport } = createMcpClient(mcpName, mcpCfg);
            try {
                const reqTimeout = mcpCfg.type === 'url'
                    ? mcpCfg.requestTimeout ?? 120000
                    : undefined;
                await client.connect(transport, reqTimeout ? { timeout: reqTimeout } : undefined);
                const result = await client.callTool({ name: toolName, arguments: ensureArgsObject(args ?? {}) }, undefined, reqTimeout ? { timeout: reqTimeout } : undefined);
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
    }
}
