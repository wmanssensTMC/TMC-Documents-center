import type { NextConfig } from "next";

// The browser may only talk to this app and the file store (review F4, editor 20/10): the
// document editor runs in the page and must never send a document anywhere else. Production
// only; the development server needs its own live-reload connection.
const CONNECT = "connect-src 'self' blob: data: https://vercel.com https://*.vercel-storage.com";
const CSP = process.env.NODE_ENV === "production" ? `frame-ancestors 'self'; ${CONNECT}` : "frame-ancestors 'self'";

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
          { key: "Content-Security-Policy", value: CSP },
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
