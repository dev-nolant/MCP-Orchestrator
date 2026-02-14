/**
 * Tokens for authenticating remote clients to tunneled MCPs.
 * Stored in secrets with key "tunnel:{mcpName}".
 */
import { getSecret, setSecret, deleteSecret, listSecretKeys } from './secrets.js';
import { randomBytes } from 'node:crypto';
const PREFIX = 'tunnel:';
export function getTunnelTokenMcpNames() {
    return listSecretKeys()
        .filter((k) => k.startsWith(PREFIX))
        .map((k) => k.slice(PREFIX.length));
}
export function getTunnelToken(mcpName) {
    return getSecret(PREFIX + mcpName);
}
export function setTunnelToken(mcpName, token) {
    setSecret(PREFIX + mcpName, token);
}
export function deleteTunnelToken(mcpName) {
    deleteSecret(PREFIX + mcpName);
}
export function generateTunnelToken() {
    return randomBytes(32).toString('hex');
}
export function isTunnelTokenValid(mcpName, token) {
    const stored = getTunnelToken(mcpName);
    return stored !== null && stored === token;
}
