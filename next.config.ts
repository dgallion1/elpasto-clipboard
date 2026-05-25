import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  async rewrites() {
    if (process.env.NODE_ENV === "production") {
      return [];
    }

    const backendPort = process.env.GO_BACKEND_PORT ?? "8080";
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${backendPort}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
