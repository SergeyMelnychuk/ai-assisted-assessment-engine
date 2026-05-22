import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/trpc/router";
import { createTRPCContextFromRequest } from "@/server/trpc/trpc";

// App-Router fetch handler for tRPC. Every query/mutation hits this file.
// The middleware matcher already blocks unauthenticated requests to
// /api/trpc/* at the edge — so `protectedProcedure` is defense in depth.
const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContextFromRequest(req),
    onError:
      process.env.NODE_ENV === "development"
        ? ({ path, error }) => {
            console.error(
              `[tRPC] ${path ?? "<no-path>"} failed: ${error.message}`,
            );
          }
        : undefined,
  });

export { handler as GET, handler as POST };
