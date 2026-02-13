const MAX_LOGS = 200;
const entries = [];
function genId() {
    return Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}
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
}
export function getLogs() {
    return [...entries];
}
export function clearLogs() {
    entries.length = 0;
}
