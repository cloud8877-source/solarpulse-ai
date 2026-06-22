/** @type {import('next').NextConfig} */
const nextConfig = {
  // @mastra/core is a server-only package with native/node deps — keep it external
  // so the bundler doesn't try to bundle it into route handlers.
  serverExternalPackages: ["@mastra/core"],
  // Pin the workspace root to this project (a stray parent-dir lockfile otherwise
  // confuses Next's root inference).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
