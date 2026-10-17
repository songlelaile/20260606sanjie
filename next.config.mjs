import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // Preserve the raw server origin for internal rewrites behind the TLS proxy.
  skipMiddlewareUrlNormalize: true,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'" }
    ] }];
  },
  async redirects() {
    return [
      { source: "/dashboards/product-opportunity", destination: "/dashboards/product-breakthrough", permanent: false },
      { source: "/dashboards/product-opportunity/:path*", destination: "/dashboards/product-breakthrough", permanent: false }
    ];
  }
};

export default nextConfig;
