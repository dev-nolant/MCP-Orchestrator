import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { runWorkflow } from './workflow.js';
import { appendLog } from './logs.js';
const CONFIG_PATH = path.join(process.cwd(), 'mcp-orchestrator.config.json');
const jobs = new Map();
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH))
        return { mcps: {}, workflows: [] };
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
export function startScheduler(config) {
    stopScheduler();
    for (const w of config.workflows) {
        if (w.trigger === 'schedule' && w.schedule?.trim()) {
            const workflowName = w.name;
            try {
                const task = cron.schedule(w.schedule.trim(), async () => {
                    const cfg = loadConfig();
                    console.log(`[Scheduler] Running workflow: ${workflowName}`);
                    try {
                        const { success, stepOutputs } = await runWorkflow(cfg, workflowName);
                        appendLog({
                            type: 'schedule',
                            message: `Workflow "${workflowName}"`,
                            detail: success ? 'Completed successfully' : 'Failed',
                            output: stepOutputs,
                            success,
                        });
                        console.log(`[Scheduler] ${workflowName}: ${success ? 'OK' : 'FAILED'}`);
                    }
                    catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        appendLog({
                            type: 'schedule',
                            message: `Workflow "${workflowName}"`,
                            detail: errMsg,
                            success: false,
                        });
                        console.error(`[Scheduler] ${workflowName} error:`, err);
                    }
                });
                jobs.set(workflowName, task);
                console.log(`[Scheduler] Scheduled: ${workflowName} (${w.schedule})`);
            }
            catch (err) {
                console.error(`[Scheduler] Invalid cron for ${workflowName}:`, w.schedule, err);
            }
        }
    }
}
export function stopScheduler() {
    for (const [name, task] of jobs) {
        task.stop();
    }
    jobs.clear();
}
