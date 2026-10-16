// Usage: npm run hash-password
// Asks for a password (hidden while typing) and prints the value for ADMIN_PASSWORD_HASH.
// Same format and cost as lib/auth/password.ts.
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

let muted = false;
const output = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });

const password = await new Promise((resolve) => {
  rl.question("Password (hidden): ", resolve);
  muted = true;
});
rl.close();
process.stdout.write("\n");

if (password.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
const N = 2 ** 17, r = 8, p = 1;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64, { N, r, p, maxmem: 256 * N * r });
console.log(`\nADMIN_PASSWORD_HASH=scrypt:${N}:${r}:${p}:${salt.toString("base64url")}:${hash.toString("base64url")}`);
