#!/usr/bin/env node
/**
 * Setup encrypted secrets storage. Prompts for a password and stores the derived key in the OS keychain.
 * Run: npm run setup-encryption
 */
import * as readline from 'node:readline';
import { storeMasterKeyInKeychain, isEncryptionEnabled } from './secrets.js';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('MCP Orchestrator — Setup Encrypted Secrets\n');
  if (isEncryptionEnabled()) {
    console.log('Encryption is already enabled (key found in env or keychain).');
    console.log('To change the password, delete the key first:');
    console.log('  macOS: Open Keychain Access → search "mcp-orchestrator" → delete\n');
    return;
  }
  const password = await prompt('Enter a password (min 8 chars) to derive encryption key: ');
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const confirm = await prompt('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  storeMasterKeyInKeychain(password, true);
  console.log('\nDone. Key stored in OS keychain. Restart the server to use encrypted secrets.');
  console.log('Existing plain secrets will be encrypted on first save.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
