import { createRouter, publicProcedure } from "../trpc";

// Tiny public router used to verify the tRPC pipeline end-to-end from a
// browser without needing auth. Safe to keep in prod — it doesn't read the
// DB and leaks no information beyond server uptime / version.
export const healthRouter = createRouter({
  ping: publicProcedure.query(() => ({
    ok: true as const,
    timestamp: new Date(),
    // Surface the runtime environment so the homepage "diagnostics" card
    // can confirm it's talking to the right build.
    env: process.env.NODE_ENV,
  })),
});
