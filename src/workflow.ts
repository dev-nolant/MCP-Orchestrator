import type { OrchestratorConfig, Workflow, WorkflowStep } from './config.js';
import { ensureArgsObject } from './args-wrappers.js';
import { createMcpClient, extractTextContent } from './connector.js';

const STEP_PLACEHOLDER = /\{\{step(\d+)\}\}/g;

function substituteStepOutputs(
  obj: unknown,
  stepOutputs: string[],
): unknown {
  if (typeof obj === 'string') {
    return obj.replace(STEP_PLACEHOLDER, (_, i) => {
      const idx = parseInt(i, 10);
      return stepOutputs[idx] ?? '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteStepOutputs(item, stepOutputs));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = substituteStepOutputs(v, stepOutputs);
    }
    return result;
  }
  return obj;
}

export async function runWorkflow(
  config: OrchestratorConfig,
  workflowName: string,
): Promise<{ stepOutputs: string[]; success: boolean }> {
  const workflow = config.workflows.find(
    (w) => w.name === workflowName || w.name.toLowerCase() === workflowName.toLowerCase(),
  );
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowName}`);
  }

  const stepOutputs: string[] = [];
  const clients = new Map<string, ReturnType<typeof createMcpClient>>();

  try {
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const mcpConfig = config.mcps[step.mcp];
      if (!mcpConfig) {
        throw new Error(`MCP "${step.mcp}" not found in config`);
      }
      if ((mcpConfig as { enabled?: boolean }).enabled === false) {
        throw new Error(`MCP "${step.mcp}" is disabled (spin down). Spin it up first.`);
      }

      let client = clients.get(step.mcp);
      if (!client) {
        client = createMcpClient(step.mcp, mcpConfig);
        const connectTimeout =
          mcpConfig.type === 'url'
            ? (mcpConfig as { requestTimeout?: number }).requestTimeout ?? 120000
            : undefined;
        await client.client.connect(
          client.transport,
          connectTimeout ? { timeout: connectTimeout } : undefined,
        );
        clients.set(step.mcp, client);
      }

      const raw = substituteStepOutputs(step.args ?? {}, stepOutputs);
      const args = ensureArgsObject(raw);

      try {
        const timeout =
          step.mcp && config.mcps[step.mcp]?.type === 'url'
            ? (config.mcps[step.mcp] as { requestTimeout?: number }).requestTimeout ?? 120000
            : undefined;
        const result = await client.client.callTool(
          { name: step.tool, arguments: args },
          undefined,
          timeout ? { timeout } : undefined,
        );

        const text = extractTextContent(result);
        stepOutputs.push(text);

        if (result.isError) {
          console.error(`Step ${i + 1} (${step.mcp}/${step.tool}) failed:`, text);
          return { stepOutputs, success: false };
        }

        console.log(`Step ${i + 1} (${step.mcp}/${step.tool}): OK`);
      } catch (stepErr) {
        const errMsg = stepErr instanceof Error ? stepErr.message : String(stepErr);
        console.error(`Step ${i + 1} (${step.mcp}/${step.tool}) threw:`, errMsg);
        stepOutputs.push(`Error: ${errMsg}`);
        return { stepOutputs, success: false };
      }
    }

    return { stepOutputs, success: true };
  } finally {
    for (const [, { client, transport }] of clients) {
      try {
        await client.close();
        await transport.close();
      } catch {
        // ignore
      }
    }
  }
}

export async function listAllTools(config: OrchestratorConfig): Promise<void> {
  for (const [name, mcpConfig] of Object.entries(config.mcps)) {
    const { client, transport } = createMcpClient(name, mcpConfig);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      console.log(`\n## ${name}`);
      for (const tool of tools) {
        console.log(`  - ${tool.name}: ${tool.description ?? '(no description)'}`);
      }
    } catch (err) {
      console.error(`\n## ${name}: FAILED - ${err}`);
    } finally {
      try {
        await client.close();
        await transport.close();
      } catch {
        // ignore
      }
    }
  }
}
