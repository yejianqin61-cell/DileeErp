import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  webpack: (config, { dev }) => {
    // ponytail: this development server runs on the factory's constrained Windows hardware; restore caching after memory capacity is confirmed.
    if (dev) config.cache = false;
    return config;
  },
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: "http://localhost:3001/api/v1/:path*" }];
  },
};

export default nextConfig;
