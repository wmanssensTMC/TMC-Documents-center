import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // "server-only" throws outside a React Server Component; tests run plain Node.
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: { environment: "node", include: ["**/*.test.ts"], exclude: ["node_modules/**", ".next/**"], testTimeout: 30000, hookTimeout: 60000 },
});
