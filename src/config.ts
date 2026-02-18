/** Config shape that may have tunnelSubdomain (full McpConfig or partial). */
export type TunnelSubdomainConfig = { tunnelSubdomain?: string } | null | undefined;

/** Normalize a value to a valid DNS subdomain (lowercase, alphanumeric and hyphens). */
export function toTunnelSubdomain(name: string, config?: TunnelSubdomainConfig): string {
  const override = config && 'tunnelSubdomain' in config ? config.tunnelSubdomain : undefined;
  const raw = (typeof override === 'string' && override.trim()) ? override.trim() : name;
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'mcp';
}

/** Shared options for tool proxying (apply to both url and stdio). */
export interface McpProxyOptions {
  /**
   * Short prefix for proxied tool names (e.g. "P" for Pieces).
   * Keeps combined "server:tool" under 60 chars for Cursor. Default: MCP name.
   */
  proxyPrefix?: string;
  /** Only expose these tools. Omit to expose all (except toolsExclude). */
  toolsInclude?: string[];
  /** Exclude these tools from proxying. Use to trim tool count or noisy MCPs. */
  toolsExclude?: string[];
}

export interface McpConfigUrl extends McpProxyOptions {
  type: 'url';
  url: string;
  /** Override subdomain for tunnel URL (e.g. "music" → music.example.com). Default: MCP name. */
  tunnelSubdomain?: string;
  /**
   * Bearer token for Authorization header. Prefer using env or secrets:
   * - "env:VAR_NAME" → read from process.env.VAR_NAME
   * - "secret:key" → read from porch.secrets.json
   * - plain string (avoid in committed config)
   */
  authorizationToken?: string;
  /** Request timeout in ms. Default 120000 (2 min) for URL MCPs to allow for slow tools like Pieces. */
  requestTimeout?: number;
  /** If false, MCP is disabled (spin down). Default true. */
  enabled?: boolean;
  /** If true, automatically spin up this MCP when the orchestrator server starts. */
  startOnStartup?: boolean;
}

export interface McpConfigStdio extends McpProxyOptions {
  type: 'stdio';
  command: string;
  /** Override subdomain for tunnel URL (e.g. "music" → music.example.com). Default: MCP name. */
  tunnelSubdomain?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** If false, MCP is disabled (spin down). Default true. */
  enabled?: boolean;
  /** If true, automatically spin up this MCP when the orchestrator server starts. */
  startOnStartup?: boolean;
}

export type McpConfig = McpConfigUrl | McpConfigStdio;

export interface WorkflowStep {
  mcp: string;
  tool: string;
  args?: Record<string, unknown>;
  /** Template: {{step0}}, {{step1.id}}, {{step1:regex:pat}}, {{now}}, {{isoDate}}, {{js: expr }}, etc. */
  mapOutputFrom?: number;
}

export interface Workflow {
  name: string;
  description?: string;
  trigger?: 'manual' | 'schedule';
  schedule?: string;
  /** UI hint: 'time' = minute/hour focus, 'date' = day/month/weekday focus */
  scheduleFormat?: 'time' | 'date';
  steps: WorkflowStep[];
}

/**
 * How to expose MCP tools to clients:
 * - "gateway" (default): One route per MCP (e.g. spotify__call, pieces__call). Pass tool + args. Keeps total tools low.
 * - "full": Every MCP tool as its own proxy (spotify__getNowPlaying, etc.). Full ergonomics but can exceed limits.
 */
export type ProxyMode = 'gateway' | 'full';

export interface OrchestratorConfig {
  mcps: Record<string, McpConfig>;
  workflows: Workflow[];
  /** How to expose MCP tools. Default "gateway" to avoid exceeding 80-tool limits. */
  proxyMode?: ProxyMode;
}
