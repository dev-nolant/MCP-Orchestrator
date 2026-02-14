/**
 * Tokens for authenticating remote clients to tunneled MCPs.
 * Stored in secrets with key "tunnel:{mcpName}".
 */
import { getSecret, setSecret, deleteSecret, listSecretKeys } from './secrets.js';
import { randomBytes } from 'node:crypto';

const PREFIX = 'tunnel:';

export function getTunnelTokenMcpNames(): string[] {
  return listSecretKeys()
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length));
}

export function getTunnelToken(mcpName: string): string | null {
  return getSecret(PREFIX + mcpName);
}

export function setTunnelToken(mcpName: string, token: string): void {
  setSecret(PREFIX + mcpName, token);
}

export function deleteTunnelToken(mcpName: string): void {
  deleteSecret(PREFIX + mcpName);
}

export function generateTunnelToken(): string {
  return randomBytes(32).toString('hex');
}

export function isTunnelTokenValid(mcpName: string, token: string): boolean {
  const stored = getTunnelToken(mcpName);
  return stored !== null && stored === token;
}
