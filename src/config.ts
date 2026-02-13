export interface McpConfigUrl {
  type: 'url';
  url: string;
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
