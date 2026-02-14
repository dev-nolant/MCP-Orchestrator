/** Config shape that may have tunnelSubdomain (full McpConfig or partial). */
export type TunnelSubdomainConfig = { tunnelSubdomain?: string } | null | undefined;

/** Normalize a value to a valid DNS subdomain (lowercase, alphanumeric and hyphens). */
export function toTunnelSubdomain(name: string, config?: TunnelSubdomainConfig): string {
  const override = config && 'tunnelSubdomain' in config ? config.tunnelSubdomain : undefined;
  const raw = (typeof override === 'string' && override.trim()) ? override.trim() : name;
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'mcp';
}

export interface McpConfigUrl {
  type: 'url';
  url: string;
  /** Override subdomain for tunnel URL (e.g. "music" → music.example.com). Default: MCP name. */
  tunnelSubdomain?: string;
  /**
   * Bearer token for Authorization header. Prefer using env or secrets:
   * - "env:VAR_NAME" → read from process.env.VAR_NAME
   * - "secret:key" → read from mcp-orchestrator.secrets.json
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

export interface McpConfigStdio {
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
  /** Template: {{step0}} = output of step 0, {{step1}} = step 1, etc. */
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

export interface OrchestratorConfig {
  mcps: Record<string, McpConfig>;
  workflows: Workflow[];
}
