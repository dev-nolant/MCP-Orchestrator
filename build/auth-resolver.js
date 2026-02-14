/**
 * Resolve Bearer token from config (env:, secret:, or literal).
 */
import { getSecret } from './secrets.js';
export function resolveAuthorizationToken(value) {
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
