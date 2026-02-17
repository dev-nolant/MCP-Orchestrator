import { ensureArgsObject } from './args-wrappers.js';
import { createMcpClient, extractTextContent } from './connector.js';
import { substituteTemplatesDeep } from './template-engine.js';
/** Resolves nested paths like "playlists[1].id" or "foo.bar[0].name". */
function getByPath(obj, path) {
    const pathStr = path.trim();
    if (!pathStr)
        return obj;
    const parts = [];
    let rest = pathStr;
    while (rest) {
        rest = rest.replace(/^\./, '');
        if (!rest)
            break;
        const bracketIdx = rest.indexOf('[');
        const dotIdx = rest.indexOf('.');
        if (bracketIdx >= 0 && (dotIdx < 0 || bracketIdx < dotIdx)) {
            if (bracketIdx > 0) {
                parts.push(rest.slice(0, bracketIdx));
            }
            const closeIdx = rest.indexOf(']', bracketIdx);
            if (closeIdx < 0)
                return undefined;
            const indexStr = rest.slice(bracketIdx + 1, closeIdx).trim();
            const num = /^\d+$/.test(indexStr) ? parseInt(indexStr, 10) : NaN;
            parts.push(isNaN(num) ? indexStr.replace(/^["']|["']$/g, '') : num);
            rest = rest.slice(closeIdx + 1);
        }
        else if (dotIdx >= 0) {
            parts.push(rest.slice(0, dotIdx));
            rest = rest.slice(dotIdx);
        }
        else {
            parts.push(rest);
            rest = '';
        }
    }
    let cur = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object')
            return undefined;
        cur = typeof p === 'number' ? cur[p] : cur[p];
    }
    return cur;
}
function substituteStepOutputs(obj, stepOutputs, input) {
    return substituteTemplatesDeep(obj, stepOutputs, getByPath, input);
}
export async function runWorkflow(config, workflowName, input) {
    const workflow = config.workflows.find((w) => w.name === workflowName || w.name.toLowerCase() === workflowName.toLowerCase());
    if (!workflow) {
        throw new Error(`Workflow not found: ${workflowName}`);
    }
    const stepOutputs = [];
    const clients = new Map();
    try {
        for (let i = 0; i < workflow.steps.length; i++) {
            const step = workflow.steps[i];
            const mcpConfig = config.mcps[step.mcp];
            if (!mcpConfig) {
                throw new Error(`MCP "${step.mcp}" not found in config`);
            }
            if (mcpConfig.enabled === false) {
                throw new Error(`MCP "${step.mcp}" is disabled (spin down). Spin it up first.`);
            }
            let client = clients.get(step.mcp);
            if (!client) {
                client = createMcpClient(step.mcp, mcpConfig);
                const connectTimeout = mcpConfig.type === 'url'
                    ? mcpConfig.requestTimeout ?? 120000
                    : undefined;
                await client.client.connect(client.transport, connectTimeout ? { timeout: connectTimeout } : undefined);
                clients.set(step.mcp, client);
            }
            const raw = substituteStepOutputs(step.args ?? {}, stepOutputs, input);
            const args = ensureArgsObject(raw);
            try {
                const timeout = step.mcp && config.mcps[step.mcp]?.type === 'url'
                    ? config.mcps[step.mcp].requestTimeout ?? 120000
                    : undefined;
                const result = await client.client.callTool({ name: step.tool, arguments: args }, undefined, timeout ? { timeout } : undefined);
                const text = extractTextContent(result);
                stepOutputs.push(text);
                if (result.isError) {
                    console.error(`Step ${i + 1} (${step.mcp}/${step.tool}) failed:`, text);
                    return { stepOutputs, success: false };
                }
                console.log(`Step ${i + 1} (${step.mcp}/${step.tool}): OK`);
            }
            catch (stepErr) {
                const errMsg = stepErr instanceof Error ? stepErr.message : String(stepErr);
                console.error(`Step ${i + 1} (${step.mcp}/${step.tool}) threw:`, errMsg);
                stepOutputs.push(`Error: ${errMsg}`);
                return { stepOutputs, success: false };
            }
        }
        return { stepOutputs, success: true };
    }
    finally {
        for (const [, { client, transport }] of clients) {
            try {
                await client.close();
                await transport.close();
            }
            catch {
                // ignore
            }
        }
    }
}
export async function listAllTools(config) {
    for (const [name, mcpConfig] of Object.entries(config.mcps)) {
        const { client, transport } = createMcpClient(name, mcpConfig);
        try {
            await client.connect(transport);
            const { tools } = await client.listTools();
            console.log(`\n## ${name}`);
            for (const tool of tools) {
                console.log(`  - ${tool.name}: ${tool.description ?? '(no description)'}`);
            }
        }
        catch (err) {
            console.error(`\n## ${name}: FAILED - ${err}`);
        }
        finally {
            try {
                await client.close();
                await transport.close();
            }
            catch {
                // ignore
            }
        }
    }
}
