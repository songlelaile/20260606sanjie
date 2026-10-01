import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const retiredAnalytics = [
  "/dashboards/management",
  "/dashboards/product-breakthrough",
  "/dashboards/audience-plan",
  "/dashboards/business-diagnosis",
  "/dashboards/product-opportunity",
  "/dashboards/diagnostics",
  "/imports",
  "/prefill"
];

const nextConfig = {
  outputFileTracingRoot: __dirname,
  async redirects() {
    return retiredAnalytics.flatMap((source) => [
      { source, destination: "/dashboards/operating-network", permanent: false },
      { source: `${source}/:path*`, destination: "/dashboards/operating-network", permanent: false }
    ]);
  }
};

export default nextConfig;
