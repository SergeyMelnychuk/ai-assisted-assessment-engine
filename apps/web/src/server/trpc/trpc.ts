import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "../db";
import { log } from "../lib/logger";

interface CreateContextOptions {
  session: Session | null;
}

export const createTRPCContext = (opts: CreateContextOptions) => {
  return {
    session: opts.session,
    db,
  };
};

// Convenience factory for the App Router fetch-based tRPC handler (wired up
// in Task 4). Resolves the NextAuth session per-request so every procedure
// sees the authenticated user. The `_req` arg is accepted so the signature
// matches `fetchRequestHandler`'s `createContext` shape.
export const createTRPCContextFromRequest = async (
  _req: Request,
): Promise<ReturnType<typeof createTRPCContext>> => {
  const session = await getServerSession(authOptions);
  return createTRPCContext({ session });
};

export type Context = ReturnType<typeof createTRPCContext>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // Expose zod validation issues under `error.data.zodError` so forms can
    // render per-field errors without string-parsing the message.
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
      },
    };
  },
});

/**
 * Error-logging middleware. Wraps every procedure so unexpected throws
 * surface as structured log rows on /admin/settings?tab=logs. Expected
 * codes (UNAUTHORIZED / FORBIDDEN / NOT_FOUND / BAD_REQUEST) are the
 * normal validation/auth noise and are intentionally skipped — only
 * INTERNAL_SERVER_ERROR and unclassified throws land in the table.
 * Source is `trpc:<router>` so each router shows as a distinct entry.
 */
const EXPECTED_TRPC_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_REQUEST",
]);

const errorLogger = t.middleware(async ({ path, next }) => {
  const result = await next();
  if (!result.ok) {
    const err = result.error;
    const code = err.code;
    if (!EXPECTED_TRPC_CODES.has(code)) {
      const router = path.split(".")[0] ?? "unknown";
      log.error("trpc procedure error", {
        source: `trpc:${router}`,
        path,
        code,
        message: err.message,
      });
    }
  }
  return result;
});

export const createRouter = t.router;
export const publicProcedure = t.procedure.use(errorLogger);

const enforceUserIsAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

export const protectedProcedure = t.procedure
  .use(errorLogger)
  .use(enforceUserIsAuthed);
