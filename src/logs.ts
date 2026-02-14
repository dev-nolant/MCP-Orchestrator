import fs from 'node:fs';
import path from 'node:path';

const MAX_LOGS = 500;
const LOGS_PATH = path.join(process.cwd(), 'mcp-orchestrator.logs.json');

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
  try {
    if (fs.existsSync(LOGS_PATH)) {
      const raw = fs.readFileSync(LOGS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as LogEntry[];
      if (Array.isArray(parsed)) {
        entries.length = 0;
        entries.push(...parsed.slice(0, MAX_LOGS));
      }
    }
  } catch {
    /* ignore corruption, start fresh */
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
  saveToDisk();
}
