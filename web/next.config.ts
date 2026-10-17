import type { NextConfig } from "next";

// Cache Components is off on purpose: every page here is per-user (login cookie),
// so there is nothing to prerender.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // PGlite (laptop database) ships WebAssembly; load it from node_modules, do not bundle it.
  serverExternalPackages: ["@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // SAMEORIGIN: the document page shows its own PDFs in a frame; other sites cannot frame us.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
