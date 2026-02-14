import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveAuthorizationToken } from './auth-resolver.js';
import type { McpConfig } from './config.js';

export function createMcpClient(name: string, config: McpConfig): {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
} {
  if (config.type === 'url') {
    const token = resolveAuthorizationToken(config.authorizationToken);
    const requestInit: RequestInit | undefined = token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit,
    });
    const client = new Client(
      { name: `mcp-orchestrator-${name}`, version: '0.1.0' },
      {},
    );
    return { client, transport };
  }

  if (config.type === 'stdio') {
    // Resolve 'node' to process.execPath so spawn works when PATH is minimal (e.g. launchd/systemd)
    const command =
      config.command === 'node' || config.command === 'node.exe'
        ? process.execPath
        : config.command;
    const transport = new StdioClientTransport({
      command,
      args: config.args ?? [],
      cwd: config.cwd,
      env: config.env,
    });
    const client = new Client(
      { name: `mcp-orchestrator-${name}`, version: '0.1.0' },
      {},
    );
    return { client, transport };
  }

  throw new Error(`Unknown MCP config type: ${(config as McpConfig).type}`);
}

export function extractTextContent(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const content = r.content ?? (r.toolResult as Record<string, unknown>)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text: string } =>
      c && typeof c === 'object' && (c as { type?: string }).type === 'text' && typeof (c as { text?: string }).text === 'string'
    )
    .map((c) => c.text)
    .join('\n');
}
