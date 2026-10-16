import type { NextConfig } from "next";

// Cache Components is off on purpose: every page here is per-user (login cookie),
// so there is nothing to prerender.
const nextConfig: NextConfig = {
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
