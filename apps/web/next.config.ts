import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  webpack: (config, { dev }) => {
    // ponytail: this development server runs on the factory's constrained Windows hardware; restore caching after memory capacity is confirmed.
    if (dev) config.cache = false;
    return config;
  },
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${process.env.API_INTERNAL_URL ?? "http://localhost:3001"}/api/v1/:path*` }];
  },
  async headers() {
    return [
      { source: "/manifest.webmanifest", headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }] },
      { source: "/_next/static/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};

export default nextConfig;
