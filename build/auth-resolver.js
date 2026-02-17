/**
 * Resolve Bearer token and env values from config (env:, secret:, or literal).
 */
import { getSecret } from './secrets.js';
/** Resolve a config value: env:VAR, secret:key, or literal. Returns null for empty/env/secret miss. */
export function resolveConfigValue(value) {
    if (!value || typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('env:')) {
        const envKey = trimmed.slice(4).trim();
        return process.env[envKey] ?? null;
    }
    if (trimmed.startsWith('secret:')) {
        const key = trimmed.slice(7).trim();
        return getSecret(key) ?? null;
    }
    return trimmed;
}
export function resolveAuthorizationToken(value) {
    return resolveConfigValue(value);
}
/** Resolve env object: each value can be env:, secret:, or literal. Merges with process.env. */
export function resolveEnv(env) {
    if (!env || typeof env !== 'object')
        return {};
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        const resolved = resolveConfigValue(v);
        if (resolved !== null)
            out[k] = resolved;
    }
    return out;
}
