import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWorkflow } from './workflow.js';
import { loadConfig } from './config-loader.js';
import { appendLog } from './logs.js';
const sessions = new Map();
function createMcpServer() {
    const server = new McpServer({
        name: 'mcp-orchestrator',
        version: '0.1.0',
    }, { capabilities: { logging: {} } });
    server.registerTool('list_workflows', {
        title: 'List Workflows',
        description: 'List all configured workflows. Use this to see which workflows are available before running one.',
        inputSchema: {},
    }, async () => {
        const config = loadConfig();
        const list = config.workflows.map((w) => ({
            name: w.name,
            description: w.description || '(no description)',
            steps: w.steps.length,
        }));
        return {
            content: [
                {
                    type: 'text',
                    text: list.length === 0
                        ? 'No workflows configured. Add workflows in the MCP Orchestrator UI.'
                        : JSON.stringify(list, null, 2),
                },
            ],
        };
    });
    server.registerTool('run_workflow', {
        title: 'Run Workflow',
        description: 'Execute a workflow by name. Use list_workflows first to see available workflows.',
        inputSchema: {
            name: z.string().describe('The exact name of the workflow to run'),
        },
    }, async ({ name }) => {
        const config = loadConfig();
        try {
            const { stepOutputs, success } = await runWorkflow(config, name);
            appendLog({
                type: 'run',
                message: `Workflow "${name}" (via MCP)`,
                detail: success ? 'Completed successfully' : 'Failed',
                output: stepOutputs,
                success,
            });
            const output = stepOutputs.length > 0 ? stepOutputs[stepOutputs.length - 1] : '(no output)';
            return {
                content: [
                    {
                        type: 'text',
                        text: success
                            ? `Workflow "${name}" completed successfully.\n\nOutput:\n${output}`
                            : `Workflow "${name}" failed.\n\nOutput:\n${output}`,
                    },
                ],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendLog({
                type: 'run',
                message: `Workflow "${name}" (via MCP)`,
                detail: msg,
                success: false,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: ${msg}`,
                    },
                ],
                isError: true,
            };
        }
    });
    return server;
}
function isInitializeRequest(body) {
    if (body && typeof body === 'object' && 'method' in body) {
        return body.method === 'initialize';
    }
    return false;
}
export async function handleMcpRequest(req, res, parsedBody) {
    const sessionId = req.headers['mcp-session-id'];
    try {
        let transport;
        if (sessionId && sessions.has(sessionId)) {
            transport = sessions.get(sessionId).transport;
        }
        else if (!sessionId && parsedBody && isInitializeRequest(parsedBody)) {
            const server = createMcpServer();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    if (sid)
                        sessions.set(sid, { server, transport });
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid)
                    sessions.delete(sid);
            };
            await server.connect(transport);
        }
        else {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID. Send initialize first.' },
                id: null,
            }));
            return;
        }
        await transport.handleRequest(req, res, parsedBody);
    }
    catch (error) {
        console.error('MCP request error:', error);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            }));
        }
    }
}
