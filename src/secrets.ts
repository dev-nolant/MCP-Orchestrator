/**
 * Secure storage for Bearer tokens and other secrets.
 * Tokens are stored in a separate file (gitignored) and never in the main config.
 */
import fs from 'node:fs';
import path from 'node:path';

const SECRETS_PATH = path.join(process.cwd(), 'mcp-orchestrator.secrets.json');

type SecretsMap = Record<string, string>;

function loadSecrets(): SecretsMap {
  try {
    if (fs.existsSync(SECRETS_PATH)) {
      const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as SecretsMap;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch {
    /* ignore corruption */
  }
  return {};
}

let cache: SecretsMap | null = null;

function getSecrets(): SecretsMap {
  if (cache === null) {
    cache = loadSecrets();
  }
  return cache;
}

function saveSecrets(secrets: SecretsMap): void {
  try {
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), 'utf8');
    cache = secrets;
  } catch (err) {
    console.error('Failed to save secrets:', err);
  }
}

export function getSecret(key: string): string | null {
  return getSecrets()[key] ?? null;
}

export function setSecret(key: string, value: string): void {
  const secrets = { ...getSecrets(), [key]: value };
  saveSecrets(secrets);
}

export function deleteSecret(key: string): void {
  const secrets = { ...getSecrets() };
  delete secrets[key];
  saveSecrets(secrets);
}

export function listSecretKeys(): string[] {
  return Object.keys(getSecrets());
}
