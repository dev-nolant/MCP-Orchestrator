import fs from 'node:fs';
import path from 'node:path';
const MAX_LOGS = 500;
const LOGS_PATH = path.join(process.cwd(), 'porch.logs.json');
const LEGACY_LOGS_PATH = path.join(process.cwd(), 'mcp-orchestrator.logs.json');
const entries = [];
function genId() {
    return Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}
function loadFromDisk() {
    const paths = [LOGS_PATH, LEGACY_LOGS_PATH];
    for (const p of paths) {
        try {
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    entries.length = 0;
                    entries.push(...parsed.slice(0, MAX_LOGS));
                }
                if (p === LEGACY_LOGS_PATH) {
                    fs.writeFileSync(LOGS_PATH, JSON.stringify(entries, null, 2), 'utf8');
                }
                return;
            }
        }
        catch {
            /* ignore corruption, try next */
        }
    }
}
function saveToDisk() {
    try {
        fs.writeFileSync(LOGS_PATH, JSON.stringify(entries, null, 2), 'utf8');
    }
    catch (err) {
        console.error('Failed to persist logs:', err);
    }
}
loadFromDisk();
export function appendLog(entry) {
    const log = {
        id: genId(),
        type: entry.type,
        message: entry.message,
        detail: entry.detail ?? null,
        output: entry.output ?? null,
        success: entry.success !== false,
        ts: new Date().toISOString(),
    };
    entries.unshift(log);
    if (entries.length > MAX_LOGS)
        entries.pop();
    saveToDisk();
}
export function getLogs() {
    return [...entries];
}
export function clearLogs() {
    entries.length = 0;
    try {
        fs.writeFileSync(LOGS_PATH, '[]', 'utf8');
    }
    catch (err) {
        console.error('Failed to clear logs:', err);
        throw err;
    }
}
