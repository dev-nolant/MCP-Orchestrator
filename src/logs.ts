const MAX_LOGS = 200;
const entries: Array<{
  id: string;
  type: string;
  message: string;
  detail: string | null;
  output: unknown;
  success: boolean;
  ts: string;
}> = [];

function genId(): string {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

export function appendLog(entry: {
  type: string;
  message: string;
  detail?: string | null;
  output?: unknown;
  success?: boolean;
}): void {
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
  if (entries.length > MAX_LOGS) entries.pop();
}

export function getLogs(): typeof entries {
  return [...entries];
}

export function clearLogs(): void {
  entries.length = 0;
}
