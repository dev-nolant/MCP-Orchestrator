/**
 * Secure storage for Bearer tokens and other secrets.
 * Tokens are stored in a separate file (gitignored) and never in the main config.
 */
import fs from 'node:fs';
import path from 'node:path';
const SECRETS_PATH = path.join(process.cwd(), 'mcp-orchestrator.secrets.json');
function loadSecrets() {
    try {
        if (fs.existsSync(SECRETS_PATH)) {
            const raw = fs.readFileSync(SECRETS_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
        }
    }
    catch {
        /* ignore corruption */
    }
    return {};
}
let cache = null;
function getSecrets() {
    if (cache === null) {
        cache = loadSecrets();
    }
    return cache;
}
function saveSecrets(secrets) {
    try {
        fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), 'utf8');
        cache = secrets;
    }
    catch (err) {
        console.error('Failed to save secrets:', err);
    }
}
export function getSecret(key) {
    return getSecrets()[key] ?? null;
}
export function setSecret(key, value) {
    const secrets = { ...getSecrets(), [key]: value };
    saveSecrets(secrets);
}
export function deleteSecret(key) {
    const secrets = { ...getSecrets() };
    delete secrets[key];
    saveSecrets(secrets);
}
export function listSecretKeys() {
    return Object.keys(getSecrets());
}
