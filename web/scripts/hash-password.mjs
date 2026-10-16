// Usage: npm run hash-password
// Asks for a password (not echoed to history) and prints the value for ADMIN_PASSWORD_HASH.
// Same format as lib/auth/password.ts.
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Password: ");
rl.close();
if (password.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
console.log(`\nADMIN_PASSWORD_HASH=scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`);
