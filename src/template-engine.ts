/**
 * Workflow template engine: {{variable}}, {{js:expression}}, {{stepN}}, etc.
 */

import { randomUUID } from 'node:crypto';

const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;

// Step placeholder: stepN, stepN.path, stepN:regex:pat, stepN:regexAll:pat
const STEP_PATTERN = /^step(\d+)(?:\.([^:}]+)|:regex:([^}]+)|:regexAll:([^}]+))?$/;

/** date.* namespace – use {{date.isoDate}}, {{date.isoTime}}, {{date.now}}, etc. */
function getDateValues(): Record<string, string | number> {
  const d = new Date();
  const iso = d.toISOString();
  return {
    now: iso,
    isoDateTime: iso,
    isoDate: iso.slice(0, 10),
    isoTime: iso.slice(11, 23),
    timestamp: d.getTime(),
    date: d.toLocaleDateString(),
    year: d.getFullYear().toString(),
    month: (d.getMonth() + 1).toString(),
    day: d.getDate().toString(),
    weekday: d.toLocaleDateString(undefined, { weekday: 'long' }),
  };
}

const BUILTINS: Record<string, () => string | number> = {
  uuid: () => randomUUID(),
  // Flat aliases (backwards compat) – delegate to date.*
  now: () => getDateValues().now as string,
  isoDateTime: () => getDateValues().isoDateTime as string,
  isoDate: () => getDateValues().isoDate as string,
  isoTime: () => getDateValues().isoTime as string,
  timestamp: () => getDateValues().timestamp as number,
  date: () => getDateValues().date as string,
  year: () => getDateValues().year as string,
  month: () => getDateValues().month as string,
  day: () => getDateValues().day as string,
  weekday: () => getDateValues().weekday as string,
};

function getEvalScope(): Record<string, unknown> {
  const now = new Date();
  return {
    now,
    date: now,
    Date,
    timestamp: Date.now(),
    uuid: randomUUID,
    Math,
    JSON,
    // Helpers
    ISO: now.toISOString(),
    YMD: now.toISOString().slice(0, 10),
    HHMM: now.toTimeString().slice(0, 5),
  };
}

function evalExpression(expr: string): unknown {
  const scope = getEvalScope();
  const keys = Object.keys(scope);
  const values = Object.values(scope);
  try {
    const fn = new Function(...keys, `return (${expr.trim()})`);
    return fn(...values);
  } catch (err) {
    console.warn(`[template] eval failed for {{js:${expr}}}:`, err);
    return '';
  }
}

export function resolvePlaceholderContent(
  content: string,
  stepOutputs: string[],
  getByPath: (obj: unknown, path: string) => unknown,
  input?: Record<string, unknown> | unknown[],
): unknown {
  const trimmed = content.trim();

  // input.* namespace – workflow input from run_workflow/API
  if (trimmed.startsWith('input.')) {
    const path = trimmed.slice(6).trim();
    if (input != null) {
      const val = getByPath(input, path);
      return val !== undefined && val !== null ? val : '';
    }
    return '';
  }

  // date.* namespace
  if (trimmed.startsWith('date.')) {
    const key = trimmed.slice(5).trim();
    const vals = getDateValues();
    return key in vals ? vals[key as keyof typeof vals] : '';
  }

  // Built-in variables (flat, for backwards compat)
  const builtin = BUILTINS[trimmed];
  if (builtin) return builtin();

  // js: expression
  if (trimmed.startsWith('js:')) {
    return evalExpression(trimmed.slice(3).trim());
  }

  // Step references: step0, step1.path, step1:regex:..., step1:regexAll:...
  const stepMatch = trimmed.match(STEP_PATTERN);
  if (stepMatch) {
    const stepIndex = parseInt(stepMatch[1], 10);
    const raw = stepOutputs[stepIndex] ?? '';

    if (stepMatch[2] !== undefined) {
      // JSON path
      try {
        const data = JSON.parse(raw) as unknown;
        const val = getByPath(data, stepMatch[2]);
        return val !== undefined ? val : '';
      } catch {
        return '';
      }
    }
    if (stepMatch[3] !== undefined) {
      // regex
      const pattern = stepMatch[3].replace(/:array$/, '').trim();
      const m = new RegExp(pattern).exec(raw);
      const val = m?.[1] ?? '';
      return stepMatch[3].endsWith(':array') ? (val ? [val] : []) : val;
    }
    if (stepMatch[4] !== undefined) {
      // regexAll
      const pattern = stepMatch[4].replace(/:array$/, '').trim();
      const re = new RegExp(pattern, 'g');
      const matches = [...raw.matchAll(re)];
      return matches.map((m) => m[1]).filter((s): s is string => s !== undefined);
    }
    return raw;
  }

  return '';
}

export function substituteTemplates(
  str: string,
  stepOutputs: string[],
  getByPath: (obj: unknown, path: string) => unknown,
  input?: Record<string, unknown> | unknown[],
): string {
  return str.replace(PLACEHOLDER_REGEX, (_, content) => {
    const resolved = resolvePlaceholderContent(content, stepOutputs, getByPath, input);
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
}

export function substituteTemplatesDeep(
  obj: unknown,
  stepOutputs: string[],
  getByPath: (obj: unknown, path: string) => unknown,
  input?: Record<string, unknown> | unknown[],
): unknown {
  if (typeof obj === 'string') {
    const matches = [...obj.matchAll(new RegExp(PLACEHOLDER_REGEX.source, 'g'))];
    if (matches.length === 0) return obj;

    const trimmed = obj.trim();
    const singleMatch = matches.length === 1 && matches[0] && trimmed === matches[0][0];
    if (singleMatch) {
      const resolved = resolvePlaceholderContent(
        matches[0][1],
        stepOutputs,
        getByPath,
        input,
      );
      return resolved;
    }

    return substituteTemplates(obj, stepOutputs, getByPath, input);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteTemplatesDeep(item, stepOutputs, getByPath, input));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = substituteTemplatesDeep(v, stepOutputs, getByPath, input);
    }
    return result;
  }
  return obj;
}

export { BUILTINS, PLACEHOLDER_REGEX };
