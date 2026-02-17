/**
 * Exposes MCP tools either as:
 * - gateway (default): one mcp__call per MCP — pass tool + args. Keeps tool count low.
 * - full: every tool as mcp__toolName. Full ergonomics but can exceed limits.
 */
import * as z from 'zod/v4';
import { loadConfig } from './config-loader.js';
import { createMcpClient, extractTextContent } from './connector.js';
import { ensureArgsObject } from './args-wrappers.js';
import { proxyToolsCache, setProxyToolsCache, type CachedProxyTool } from './proxy-tools-cache.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyMode } from './config.js';

const PROXY_SEP = '__';

export { invalidateProxyToolsCache } from './proxy-tools-cache.js';

async function fetchProxiedToolsFull(): Promise<CachedProxyTool[]> {
  if (proxyToolsCache) return proxyToolsCache;

  const config = loadConfig();
  const tools: CachedProxyTool[] = [];

  for (const [mcpName, mcpConfig] of Object.entries(config.mcps)) {
    if ((mcpConfig as { enabled?: boolean }).enabled === false) continue;
    const proxyOpts = mcpConfig as { proxyPrefix?: string; toolsInclude?: string[]; toolsExclude?: string[] };
    const prefix = (typeof proxyOpts.proxyPrefix === 'string' && proxyOpts.proxyPrefix.trim())
      ? proxyOpts.proxyPrefix.trim()
      : mcpName;
    try {
      const { client, transport } = createMcpClient(mcpName, mcpConfig);
      const timeout =
        mcpConfig.type === 'url'
          ? (mcpConfig as { requestTimeout?: number }).requestTimeout ?? 120000
          : undefined;
      await client.connect(transport, timeout ? { timeout } : undefined);
      const { tools: mcpTools } = await client.listTools();
      await client.close();
      await transport.close();

      const include = proxyOpts.toolsInclude;
      const exclude = new Set(proxyOpts.toolsExclude ?? []);

      for (const t of mcpTools) {
        if (include && !include.includes(t.name)) continue;
        if (exclude.has(t.name)) continue;

        tools.push({
          proxyName: `${prefix}${PROXY_SEP}${t.name}`,
          mcpName,
          toolName: t.name,
          title: t.title ?? t.name,
          description: `[${mcpName}] ${t.description ?? t.name}`,
          inputSchema: t.inputSchema ?? {},
        });
      }
    } catch {
    }
  }

  setProxyToolsCache(tools);
  return tools;
}

export async function fetchProxiedTools(): Promise<CachedProxyTool[]> {
  const cache = proxyToolsCache;
  if (cache) return cache;
  const config = loadConfig();
  const mode: ProxyMode = config.proxyMode ?? 'gateway';
  if (mode === 'gateway') {
    return [];
  }
  return fetchProxiedToolsFull();
}

export function isProxyToolName(name: string): boolean {
  return name.includes(PROXY_SEP);
}

export function parseProxyToolName(name: string): { mcp: string; tool: string } | null {
  const idx = name.indexOf(PROXY_SEP);
  if (idx < 0) return null;
  return {
    mcp: name.slice(0, idx),
    tool: name.slice(idx + PROXY_SEP.length),
  };
}

async function registerGatewayTools(server: McpServer): Promise<void> {
  const config = loadConfig();
  for (const [mcpName, mcpConfig] of Object.entries(config.mcps)) {
    if ((mcpConfig as { enabled?: boolean }).enabled === false) continue;
    const proxyOpts = mcpConfig as { proxyPrefix?: string };
    const prefix =
      typeof proxyOpts.proxyPrefix === 'string' && proxyOpts.proxyPrefix.trim()
        ? proxyOpts.proxyPrefix.trim()
        : mcpName;
    const gatewayName = `${prefix}${PROXY_SEP}call`;

    async function handler(params: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
      const raw = (params || {}) as { tool?: string; args?: Record<string, unknown> };
      const toolName = raw.tool;
      const args = raw.args ?? {};
      if (!toolName || typeof toolName !== 'string') {
        return {
          content: [{ type: 'text' as const, text: 'Missing required "tool" argument' }],
          isError: true,
        };
      }
      const mcpCfg = loadConfig().mcps[mcpName];
      if (!mcpCfg) {
        return {
          content: [{ type: 'text' as const, text: `MCP "${mcpName}" not found` }],
          isError: true,
        };
      }
      if ((mcpCfg as { enabled?: boolean }).enabled === false) {
        return {
          content: [{ type: 'text' as const, text: `MCP "${mcpName}" is disabled. Enable it first.` }],
          isError: true,
        };
      }
      const { client, transport } = createMcpClient(mcpName, mcpCfg);
      try {
        const reqTimeout =
          mcpCfg.type === 'url'
            ? (mcpCfg as { requestTimeout?: number }).requestTimeout ?? 120000
            : undefined;
        await client.connect(transport, reqTimeout ? { timeout: reqTimeout } : undefined);
        const result = await client.callTool(
          { name: toolName, arguments: ensureArgsObject(args) },
          undefined,
          reqTimeout ? { timeout: reqTimeout } : undefined,
        );
        const text = extractTextContent(result);
        return {
          content: [{ type: 'text' as const, text: result.isError ? `Error: ${text}` : text }],
          isError: Boolean(result.isError),
        };
      } finally {
        try {
          await client.close();
          await transport.close();
        } catch {
          /* ignore */
        }
      }
    }

    server.registerTool(
      gatewayName,
      {
        title: `Call ${mcpName} tool`,
        description: `Invoke any tool on the "${mcpName}" MCP. Use list_tools(mcp="${mcpName}") to see available tools.`,
        inputSchema: {
          tool: z.string().describe('Tool name (e.g. getNowPlaying, create_pieces_memory)'),
          args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments'),
        },
      },
      handler,
    );
  }
}

export async function registerProxiedTools(server: McpServer): Promise<void> {
  const config = loadConfig();
  const mode: ProxyMode = config.proxyMode ?? 'gateway';

  if (mode === 'gateway') {
    await registerGatewayTools(server);
    return;
  }

  const proxiedTools = await fetchProxiedToolsFull();
  for (const { proxyName, mcpName, toolName, title, description, inputSchema } of proxiedTools) {
    const mcpConfig = config.mcps[mcpName];
    if (!mcpConfig || (mcpConfig as { enabled?: boolean }).enabled === false) continue;

    server.registerTool(
      proxyName,
      {
        title,
        description,
        inputSchema: z.record(z.string(), z.unknown()),
      },
      async (args: Record<string, unknown>) => {
        const mcpCfg = loadConfig().mcps[mcpName];
        if (!mcpCfg) {
          return {
            content: [{ type: 'text' as const, text: `MCP "${mcpName}" not found` }],
            isError: true,
          };
        }
        if ((mcpCfg as { enabled?: boolean }).enabled === false) {
          return {
            content: [{ type: 'text' as const, text: `MCP "${mcpName}" is disabled. Enable it first.` }],
            isError: true,
          };
        }
        const { client, transport } = createMcpClient(mcpName, mcpCfg);
        try {
          const reqTimeout =
            mcpCfg.type === 'url'
              ? (mcpCfg as { requestTimeout?: number }).requestTimeout ?? 120000
              : undefined;
          await client.connect(transport, reqTimeout ? { timeout: reqTimeout } : undefined);
          const result = await client.callTool(
            { name: toolName, arguments: ensureArgsObject(args ?? {}) },
            undefined,
            reqTimeout ? { timeout: reqTimeout } : undefined,
          );
          const text = extractTextContent(result);
          return {
            content: [{ type: 'text' as const, text: result.isError ? `Error: ${text}` : text }],
            isError: Boolean(result.isError),
          };
        } finally {
          try {
            await client.close();
            await transport.close();
          } catch {
            /* ignore */
          }
        }
      },
    );
  }
}
