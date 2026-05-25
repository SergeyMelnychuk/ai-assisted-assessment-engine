import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Server Actions are stable; only the bodySizeLimit tuning lives under
    // `experimental` in Next 15.x. 10MB lets us accept larger RFPs and
    // architecture docs via form-upload actions.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
