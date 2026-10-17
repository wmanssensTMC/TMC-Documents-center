// Runs before `next build`. Applies database migrations to Neon when DATABASE_URL is set;
// does nothing otherwise (laptop and GitHub checks migrate PGlite on first use).
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: no DATABASE_URL, skipped");
  process.exit(0);
}
const pool = new Pool({ connectionString: url });
await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
await pool.end();
console.log("migrate: done");
