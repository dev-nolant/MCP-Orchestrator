/**
 * Secure storage for Bearer tokens and other secrets.
 * Master key is read from: 1) PORCH_MASTER_KEY env, 2) MCP_ORCHESTRATOR_MASTER_KEY (legacy), 3) OS keychain.
 * When a master key is available, secrets are stored encrypted (AES-256-GCM).
 * Otherwise falls back to plain JSON (legacy).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import keytar from 'keytar-sync';
const { getPasswordSync, setPasswordSync, deletePasswordSync } = keytar;
const SECRETS_PATH = path.join(process.cwd(), 'porch.secrets.json');
const LEGACY_SECRETS_PATH = path.join(process.cwd(), 'mcp-orchestrator.secrets.json');
const KEYCHAIN_SERVICE = 'porch';
const KEYCHAIN_ACCOUNT = 'master-key';
const LEGACY_KEYCHAIN_SERVICE = 'mcp-orchestrator';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const PBKDF2_SALT = 'porch-secrets-v1';
const PBKDF2_ITERATIONS = 100000;
function getMasterKeyFromKeychain() {
    try {
        const fromPorch = getPasswordSync(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        if (fromPorch)
            return fromPorch;
    }
    catch { /* ignore */ }
    try {
        return getPasswordSync(LEGACY_KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    }
    catch {
        return null;
    }
}
function getMasterKey() {
    let raw = process.env.PORCH_MASTER_KEY?.trim() || process.env.MCP_ORCHESTRATOR_MASTER_KEY?.trim();
    if (!raw) {
        const fromKeychain = getMasterKeyFromKeychain();
        if (fromKeychain) {
            process.env.PORCH_MASTER_KEY = fromKeychain;
            raw = fromKeychain;
        }
    }
    if (!raw)
        return null;
    try {
        const buf = Buffer.from(raw, 'base64');
        if (buf.length === KEY_LEN)
            return buf;
        // Derive from passphrase if not 32-byte base64
        return crypto.pbkdf2Sync(raw, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
    }
    catch {
        return crypto.pbkdf2Sync(raw, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
    }
}
function encrypt(plain, key) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        v: 1,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: enc.toString('base64'),
    };
}
function decrypt(payload, key) {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const enc = Buffer.from(payload.data, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
}
function isEncryptedPayload(obj) {
    return (obj !== null &&
        typeof obj === 'object' &&
        'v' in obj &&
        'iv' in obj &&
        'tag' in obj &&
        'data' in obj);
}
function getSecretsPath() {
    if (fs.existsSync(SECRETS_PATH))
        return SECRETS_PATH;
    if (fs.existsSync(LEGACY_SECRETS_PATH))
        return LEGACY_SECRETS_PATH;
    return SECRETS_PATH; // write to new path
}
function loadSecrets() {
    try {
        const secretsPath = getSecretsPath();
        if (!fs.existsSync(secretsPath))
            return {};
        const raw = fs.readFileSync(secretsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const key = getMasterKey();
        if (key) {
            if (isEncryptedPayload(parsed)) {
                const dec = decrypt(parsed, key);
                const out = JSON.parse(dec);
                return out && typeof out === 'object' ? out : {};
            }
            // Legacy plain file + master key set: migrate to encrypted on next save
            if (parsed && typeof parsed === 'object' && !('v' in parsed)) {
                const legacy = parsed;
                if (Object.values(legacy).every((v) => typeof v === 'string')) {
                    saveSecrets(legacy);
                    return legacy;
                }
            }
            return {};
        }
        // No master key: legacy plain JSON
        if (parsed && typeof parsed === 'object') {
            const legacy = parsed;
            if (Object.values(legacy).every((v) => typeof v === 'string'))
                return legacy;
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
        const key = getMasterKey();
        const pathToUse = getSecretsPath();
        const writePath = pathToUse === LEGACY_SECRETS_PATH ? SECRETS_PATH : pathToUse; // migrate to new path
        if (key) {
            const plain = JSON.stringify(secrets);
            const payload = encrypt(plain, key);
            fs.writeFileSync(writePath, JSON.stringify(payload), 'utf8');
        }
        else {
            fs.writeFileSync(writePath, JSON.stringify(secrets, null, 2), 'utf8');
        }
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
/** Generate a new base64-encoded 32-byte master key for installation. */
export function generateMasterKey() {
    return crypto.randomBytes(KEY_LEN).toString('base64');
}
/** Derive 32-byte key from passphrase (PBKDF2). Returns base64-encoded key. */
export function deriveKeyFromPassword(password) {
    const key = crypto.pbkdf2Sync(password, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
    return key.toString('base64');
}
/**
 * Store master key in OS keychain. Call during setup.
 * Pass either a base64 key (from generateMasterKey) or a passphrase (will be derived).
 */
export function storeMasterKeyInKeychain(keyOrPassphrase, isPassphrase = true) {
    const key = isPassphrase ? deriveKeyFromPassword(keyOrPassphrase) : keyOrPassphrase;
    setPasswordSync(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key);
}
/** Remove master key from OS keychain. */
export function deleteMasterKeyFromKeychain() {
    try {
        deletePasswordSync(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    }
    catch {
        /* ignore */
    }
}
/** Ensure keychain is checked at startup (populates env from keychain if needed). */
export function bootstrapSecretsFromKeychain() {
    getMasterKey();
}
/** Return true if master key is configured and encryption is active. */
export function isEncryptionEnabled() {
    return getMasterKey() !== null;
}
