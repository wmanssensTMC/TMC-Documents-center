// Usage: npm run hash-password
// Asks for a password (hidden while typing) and prints the value for ADMIN_PASSWORD_HASH.
// Same format and cost as lib/auth/password.ts.
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
// Hide what is typed, but still show the prompt and the final newline.
rl._writeToOutput = (s) => {
  if (!muted || s.includes("\n") || s.includes("\r")) rl.output.write(muted ? "\n" : s);
};

const password = await new Promise((resolve) => {
  rl.question("Password (hidden, then press Enter): ", (answer) => resolve(answer));
  muted = true;
});
rl.close();

if (password.length < 12 || password.length > 256) {
  console.error("Use 12 to 256 characters. Run the command again.");
  process.exit(1);
}
console.log("Working...");
const N = 2 ** 17, r = 8, p = 1;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64, { N, r, p, maxmem: 256 * N * r });
console.log(`\nADMIN_PASSWORD_HASH=scrypt:${N}:${r}:${p}:${salt.toString("base64url")}:${hash.toString("base64url")}`);
