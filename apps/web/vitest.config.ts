import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Integration suites live here; they mock Prisma + Redis so unit and
    // integration tests can share the Node environment.
    environment: "node",
    // `attempts: 1` extends to tests — no retries-until-green.
    retry: 0,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
