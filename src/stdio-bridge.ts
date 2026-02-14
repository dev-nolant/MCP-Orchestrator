/**
 * HTTP-to-stdio bridge: exposes a stdio MCP over Streamable HTTP so it can be tunneled.
 * Spawns the stdio process, creates an HTTP server that proxies MCP messages.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfigStdio } from './config.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface StdioBridgeResult {
  port: number;
  baseUrl: string;
  fullMcpUrl: string;
  stop: () => Promise<void>;
}

/**
 * Start an HTTP-to-stdio bridge for the given stdio MCP config.
 * Returns the port, base URL, and full MCP URL (base + /mcp path).
 */
export async function startStdioBridge(
  mcpName: string,
  config: McpConfigStdio,
): Promise<StdioBridgeResult> {
  const pendingResponses = new Map<
    string | number,
    { resolve: (msg: JSONRPCMessage) => void; reject: (err: Error) => void }
  >();

  const stdioTransport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd,
    env: config.env,
  });

  stdioTransport.onmessage = (message: JSONRPCMessage) => {
    const id = (message as { id?: string | number }).id;
    if (id !== undefined && id !== null) {
      const pending = pendingResponses.get(id);
      if (pending) {
        pendingResponses.delete(id);
        pending.resolve(message);
      }
    }
  };

  stdioTransport.onerror = (err) => {
    for (const [, pending] of pendingResponses) {
      pending.reject(err);
    }
    pendingResponses.clear();
  };

  await stdioTransport.start();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });

  transport.onmessage = async (message: JSONRPCMessage, _extra?: unknown) => {
    const msg = message as { id?: string | number };
    if (isJSONRPCRequest(message) && msg.id !== undefined && msg.id !== null) {
      const responsePromise = new Promise<JSONRPCMessage>((resolve, reject) => {
        pendingResponses.set(msg.id!, { resolve, reject });
      });
      try {
        await stdioTransport.send(message);
        const response = await responsePromise;
        await transport.send(response);
      } catch (err) {
        pendingResponses.delete(msg.id!);
        await transport.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } else {
      await stdioTransport.send(message);
    }
  };

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, MCP-Session-Id, MCP-Protocol-Version',
      });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
      res.writeHead(405);
      res.end();
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = undefined;
      }
    } else {
      body = undefined;
    }
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && addr.port) {
        resolve();
      } else {
        reject(new Error('Failed to get bound port'));
      }
    });
    server.on('error', reject);
  });

  const addr = server.address();
  if (!addr || typeof addr !== 'object' || !addr.port) {
    await stdioTransport.close();
    throw new Error('Bridge server failed to bind');
  }

  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const fullMcpUrl = `${baseUrl}/mcp`;

  const stop = async () => {
    server.close();
    await transport.close();
    await stdioTransport.close();
  };

  return { port, baseUrl, fullMcpUrl, stop };
}
