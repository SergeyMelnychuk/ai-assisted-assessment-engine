/**
 * Structured application logger — stdout + optional DB persistence.
 *
 * Originally (Phase 3 Week 8) this was worker-only and wrote to
 * stdout in JSON (prod) or pretty (dev). It's now the shared logger
 * for workers and tRPC paths, with an optional fire-and-forget write
 * to the `Log` table so `/admin/logs` can serve a searchable history.
 *
 * Design rules:
 *   - Zero-latency hot path. The Prisma insert is never awaited; a
 *     `.catch` falls back to stderr if the write fails. A wedged DB
 *     must never take down the worker or a request.
 *   - Transparent to callers. Every existing `log.info / log.warn /
 *     log.error` call site works unchanged.
 *   - Secrets never land in the table. A redactor strips keys named
 *     password / token / apiKey / authorization / cookie (case-
 *     insensitive) from the context JSON before insert.
 *   - Structured-field pluck. `userId`, `assessmentId`, `jobId` in
 *     the context are lifted to dedicated columns so the admin UI
 *     can filter on them — the raw context is still stored for the
 *     row-detail drawer.
 *   - Env gate. `LOG_PERSIST_ENABLED=false` turns persistence off
 *     (e.g. during an incident). Test runs (`NODE_ENV=test` or
 *     `VITEST=true`) default to off unless `LOG_PERSIST_ENABLED=true`
 *     is explicitly set — otherwise every unit test would pollute
 *     the table.
 *
 * TODO(retention): old rows should be pruned after ~30 days by a
 * scheduled job. Not implemented yet; add when this surface is
 * actually in use and the table starts to grow.
 */

import { db } from "../db";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  /** Which worker / tRPC router emitted the log — e.g. "ingest-archive". */
  worker?: string;
  /** BullMQ job id when available. */
  jobId?: string;
  /** Assessment correlation id — lifted to a column for filtering. */
  assessmentId?: string;
  /** User correlation id — lifted to a column for filtering. */
  userId?: string;
  /** Any other contextual fields. Values must be JSON-serialisable. */
  [key: string]: unknown;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isDebugEnabled(): boolean {
  return process.env.DEBUG_WORKERS === "1";
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

/** Persistence gate. Exposed for unit tests. */
export function isPersistenceEnabled(): boolean {
  const raw = process.env.LOG_PERSIST_ENABLED;
  if (isTestEnv()) {
    // Tests default to OFF unless the env explicitly opts in.
    return raw === "true";
  }
  if (raw === undefined) return true;
  return raw !== "false";
}

const REDACT_KEYS = new Set(
  ["password", "token", "apikey", "authorization", "cookie"].map((k) =>
    k.toLowerCase(),
  ),
);

/**
 * Walk an arbitrary value and replace any property whose key matches
 * `REDACT_KEYS` (case-insensitive) with the string `"[redacted]"`.
 * Non-object inputs are returned as-is. Handles nested objects and
 * arrays. Circular references are broken with a sentinel so a logged
 * graph with back-edges can't wedge the redactor.
 */
export function redactContext(input: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        out[k] = "[redacted]";
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  };
  return walk(input);
}

interface PluckedCorrelators {
  userId: string | null;
  assessmentId: string | null;
  jobId: string | null;
}

/**
 * Extract the known correlator keys from a context object, coercing
 * to string when present. Exported for unit tests.
 */
export function pluckCorrelators(fields: LogFields | undefined): PluckedCorrelators {
  if (!fields) return { userId: null, assessmentId: null, jobId: null };
  const pick = (k: string): string | null => {
    const v = fields[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    userId: pick("userId"),
    assessmentId: pick("assessmentId"),
    jobId: pick("jobId"),
  };
}

function inferSource(fields: LogFields | undefined): string {
  if (!fields) return "app";
  if (typeof fields.worker === "string" && fields.worker.length > 0) {
    return `worker:${fields.worker}`;
  }
  if (typeof fields.source === "string" && fields.source.length > 0) {
    return fields.source;
  }
  return "app";
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (level === "debug" && !isDebugEnabled()) return;

  const ts = new Date().toISOString();
  const record = { ts, level, msg, ...(fields ?? {}) };

  if (isProduction()) {
    try {
      // One-line JSON — aggregator-friendly.
      // eslint-disable-next-line no-console
      (level === "error" ? console.error : console.log)(JSON.stringify(record));
    } catch {
      // JSON.stringify tripped (circular ref / BigInt). Flatten.
      // eslint-disable-next-line no-console
      (level === "error" ? console.error : console.log)(
        `${ts} ${level} ${msg}`,
      );
    }
  } else {
    // Development — pretty, still grep-friendly.
    const prefix = levelPrefix(level);
    const fieldStr = fields ? ` ${formatFields(fields)}` : "";
    const line = `${prefix} ${msg}${fieldStr}`;
    // eslint-disable-next-line no-console
    (level === "error" ? console.error : console.log)(line);
  }

  // Fire-and-forget DB write. Caller never awaits this.
  if (isPersistenceEnabled()) {
    void persist(level, msg, fields);
  }
}

async function persist(
  level: LogLevel,
  msg: string,
  fields: LogFields | undefined,
): Promise<void> {
  try {
    const { userId, assessmentId, jobId } = pluckCorrelators(fields);
    const redacted = fields ? (redactContext(fields) as Record<string, unknown>) : null;
    // Extract error stack for ERROR rows. Accept either a nested Error
    // object or a pre-stringified `error` field.
    let errorText: string | null = null;
    if (level === "error" && fields) {
      const raw = fields.error ?? fields.err ?? fields.cause;
      if (raw instanceof Error) {
        errorText = raw.stack ?? raw.message;
      } else if (typeof raw === "string") {
        errorText = raw;
      }
    }
    await db.log.create({
      data: {
        level: level.toUpperCase() as "DEBUG" | "INFO" | "WARN" | "ERROR",
        source: inferSource(fields),
        message: msg,
        context: (redacted as object | null) ?? undefined,
        userId,
        assessmentId,
        jobId,
        error: errorText,
      },
    });
  } catch (err) {
    // Persistence must not throw. Fall back to stderr and drop the row.
    // eslint-disable-next-line no-console
    console.error(
      `[logger] failed to persist log row: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function levelPrefix(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "[debug]";
    case "info":
      return "[info] ";
    case "warn":
      return "[warn] ";
    case "error":
      return "[error]";
  }
}

function formatFields(fields: LogFields): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(" ");
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
