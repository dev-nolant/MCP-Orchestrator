/** In-memory cache for proxied MCP tools. Invalidate when config changes. */
export interface CachedProxyTool {
  proxyName: string;
  mcpName: string;
  toolName: string;
  title: string;
  description: string;
  inputSchema: unknown;
}

export let proxyToolsCache: CachedProxyTool[] | null = null;

export function setProxyToolsCache(tools: CachedProxyTool[] | null): void {
  proxyToolsCache = tools;
}

export function invalidateProxyToolsCache(): void {
  proxyToolsCache = null;
}
