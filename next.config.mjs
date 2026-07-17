/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root to this project (a stray parent-dir lockfile otherwise
  // confuses Next's root inference).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
