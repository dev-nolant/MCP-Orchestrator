/**
 * Proxy for tunneled MCP requests. Validates Bearer token and forwards to the MCP.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from './config-loader.js';
import { isTunnelTokenValid } from './tunnel-tokens.js';
import { startStdioBridge } from './stdio-bridge.js';
import { appendLog } from './logs.js';
import type { McpConfig } from './config.js';

const bridges = new Map<
  string,
  { url: string; stop: () => Promise<void> }
>();

async function getMcpUrl(mcpName: string, forceFresh?: boolean): Promise<string | null> {
  const config = loadConfig();
  const mcp = config.mcps[mcpName];
  if (!mcp) return null;

  if (mcp.type === 'url') return mcp.url;

  if (mcp.type === 'stdio') {
    if (forceFresh) {
      const existing = bridges.get(mcpName);
      if (existing) {
        existing.stop().catch(() => {});
        bridges.delete(mcpName);
        appendLog({
          type: 'tunnel',
          message: `Bridge recycled for ${mcpName} (stale session)`,
          detail: null,
          success: true,
        });
      }
    }

    let bridge = bridges.get(mcpName);
    if (!bridge) {
      try {
        const b = await startStdioBridge(mcpName, mcp);
        bridge = { url: b.fullMcpUrl, stop: b.stop };
        bridges.set(mcpName, bridge);
        appendLog({
          type: 'tunnel',
          message: `Bridge started for ${mcpName}`,
          detail: b.fullMcpUrl,
          success: true,
        });
      } catch (err) {
        appendLog({
          type: 'tunnel',
          message: `Bridge failed for ${mcpName}: ${err instanceof Error ? err.message : String(err)}`,
          detail: null,
          output: err instanceof Error ? { stack: err.stack } : null,
          success: false,
        });
        throw err;
      }
    }
    return bridge.url;
  }

  return null;
}

function getTokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const q = url.searchParams.get('token');
  return q?.trim() ?? null;
}

export async function handleTunnelProxy(
  req: IncomingMessage,
  res: ServerResponse,
  mcpName: string,
  opts?: { subdomainRouting?: boolean },
): Promise<void> {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('WWW-Authenticate', 'Bearer realm="tunnel"');
      res.end(JSON.stringify({ error: 'Missing or invalid token. Use Authorization: Bearer <token> or ?token=' }));
      return;
    }

    if (!isTunnelTokenValid(mcpName, token)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid token for this MCP' }));
      return;
    }

    const targetBase = await getMcpUrl(mcpName);
    if (!targetBase) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `MCP "${mcpName}" not found` }));
      return;
    }

    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid request URL' }));
      return;
    }

    const prefix = opts?.subdomainRouting ? null : `/tunnel/${mcpName}`;
    const pathAfter =
      prefix === null
        ? reqUrl.pathname || '/'
        : reqUrl.pathname === prefix || reqUrl.pathname.startsWith(prefix + '/')
          ? reqUrl.pathname.slice(prefix.length) || '/'
          : '/';
    const q = reqUrl.searchParams;
  q.delete('token');
  const query = q.toString();
  // Avoid appending "/" when pathAfter is "/" — some MCPs (e.g. Pieces) treat /mcp vs /mcp/ differently
  const pathSuffix = pathAfter === '/' ? '' : pathAfter;
  const targetUrl = targetBase.replace(/\/$/, '') + pathSuffix + (query ? `?${query}` : '');

  const forwardHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v && !['host', 'authorization'].includes(k.toLowerCase())) {
      forwardHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
  }

  let body: Buffer | undefined;
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }

  const config = loadConfig();
  const mcpConfig = config.mcps[mcpName] as { requestTimeout?: number } | undefined;
  const timeoutMs = mcpConfig?.requestTimeout ?? 60000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const mcp = config.mcps[mcpName];
  const isStdio = mcp?.type === 'stdio';

  try {
  let fetchRes = await fetch(targetUrl, {
    method: req.method ?? 'GET',
    headers: forwardHeaders,
    body: body?.length ? new Uint8Array(body) : undefined,
    signal: controller.signal,
  });

  // Stdio bridge can get stuck "already initialized" when a previous client (e.g. workflow) didn't close. Recycle and retry once.
  if (
    isStdio &&
    fetchRes.status === 400 &&
    fetchRes.headers.get('content-type')?.includes('json')
  ) {
    const resBody0 = await fetchRes.arrayBuffer();
    const text = Buffer.from(resBody0).toString('utf8');
    if (text.includes('Server already initialized')) {
      const targetBaseFresh = await getMcpUrl(mcpName, true);
      if (targetBaseFresh) {
        const targetUrlFresh = targetBaseFresh.replace(/\/$/, '') + pathSuffix + (query ? `?${query}` : '');
        const controller2 = new AbortController();
        const timeoutId2 = setTimeout(() => controller2.abort(), timeoutMs);
        try {
          fetchRes = await fetch(targetUrlFresh, {
            method: req.method ?? 'GET',
            headers: forwardHeaders,
            body: body?.length ? new Uint8Array(body) : undefined,
            signal: controller2.signal,
          });
          clearTimeout(timeoutId2);
        } catch {
          clearTimeout(timeoutId2);
          throw new Error('Retry after recycle failed');
        }
      } else {
        clearTimeout(timeoutId);
        res.statusCode = 400;
        fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(resBody0));
        return;
      }
    } else {
      clearTimeout(timeoutId);
      res.statusCode = fetchRes.status;
      fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(resBody0));
      return;
    }
  }

  clearTimeout(timeoutId);
  res.statusCode = fetchRes.status;
  fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
  const resBody = await fetchRes.arrayBuffer();
  res.end(Buffer.from(resBody));
  } catch (err) {
    clearTimeout(timeoutId);
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? `Upstream timed out after ${timeoutMs}ms`
        : String(err);
    appendLog({
      type: 'tunnel',
      message: `Proxy 502 for ${mcpName}: ${msg}`,
      detail: targetUrl,
      output: { method: req.method, mcpName },
      success: false,
    });
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: msg }));
    }
  }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    appendLog({
      type: 'tunnel',
      message: `Proxy 500 for ${mcpName}: ${errMsg}`,
      detail: req.url ?? undefined,
      output: err instanceof Error ? { name: err.name, stack: err.stack } : null,
      success: false,
    });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: errMsg }));
    }
  }
}

export function stopAllBridges(): void {
  for (const [, bridge] of bridges) {
    bridge.stop().catch(() => {});
  }
  bridges.clear();
}
