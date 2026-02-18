import fs from 'node:fs';
import path from 'node:path';

const MAX_LOGS = 500;
const LOGS_PATH = path.join(process.cwd(), 'porch.logs.json');
const LEGACY_LOGS_PATH = path.join(process.cwd(), 'mcp-orchestrator.logs.json');

export type LogEntry = {
  id: string;
  type: string;
  message: string;
  detail: string | null;
  output: unknown;
  success: boolean;
  ts: string;
};

const entries: LogEntry[] = [];

function genId(): string {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

function loadFromDisk(): void {
  const paths = [LOGS_PATH, LEGACY_LOGS_PATH];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw) as LogEntry[];
        if (Array.isArray(parsed)) {
          entries.length = 0;
          entries.push(...parsed.slice(0, MAX_LOGS));
        }
        if (p === LEGACY_LOGS_PATH) {
          fs.writeFileSync(LOGS_PATH, JSON.stringify(entries, null, 2), 'utf8');
        }
        return;
      }
    } catch {
      /* ignore corruption, try next */
    }
  }
}

function saveToDisk(): void {
  try {
    fs.writeFileSync(LOGS_PATH, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist logs:', err);
  }
}

loadFromDisk();

export function appendLog(entry: {
  type: string;
  message: string;
  detail?: string | null;
  output?: unknown;
  success?: boolean;
}): void {
  const log: LogEntry = {
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
  saveToDisk();
}

export function getLogs(): LogEntry[] {
  return [...entries];
}

export function clearLogs(): void {
  entries.length = 0;
  try {
    fs.writeFileSync(LOGS_PATH, '[]', 'utf8');
  } catch (err) {
    console.error('Failed to clear logs:', err);
    throw err;
  }
}
