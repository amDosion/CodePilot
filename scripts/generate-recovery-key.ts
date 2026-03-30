/**
 * Generate a recovery key for the first (existing) user.
 * Usage: npx tsx scripts/generate-recovery-key.ts
 */
import { getFirstUser, ensureAuthTables } from '../src/lib/auth/store';
import { generateRecoveryKeyForUser } from '../src/lib/auth/service';
import * as fs from 'fs';
import * as path from 'path';

ensureAuthTables();

const user = getFirstUser();
if (!user) {
  console.error('No user found in the database. Register first.');
  process.exit(1);
}

console.log(`Found user: ${user.username} (${user.display_name}) [${user.id}]`);

const { keyFile } = generateRecoveryKeyForUser(user.id);

const outPath = path.join(process.cwd(), 'codepilot-recovery.codepilot-key');
fs.writeFileSync(outPath, JSON.stringify(keyFile, null, 2), 'utf-8');

console.log(`Recovery key generated and saved to: ${outPath}`);
console.log('You can now use this file to log in via the "Import recovery key file" option on the login page.');
