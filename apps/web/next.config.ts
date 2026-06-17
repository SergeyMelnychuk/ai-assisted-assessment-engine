import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Server-only packages that must NOT be bundled by webpack — they
  // carry native `.node` addons or otherwise don't survive bundling,
  // and are only ever reached from route handlers / tRPC procedures
  // running on the Node server. Listing them here tells Next to
  // `require()` them at runtime instead of walking them into the
  // bundle, which is what produced
  //   "Module parse failed: Unexpected character"
  // on `@node-rs/crc32`'s `.darwin-arm64.node` binary (pulled in via
  // yauzl-promise from the deliverable template-fill stack).
  serverExternalPackages: [
    "yauzl",
    "yauzl-promise",
    "yazl",
    "@node-rs/crc32",
    "exceljs",
    "puppeteer",
    "pdf-parse",
    "mammoth",
  ],
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
