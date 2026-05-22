"use client";

import { useRef } from "react";

/**
 * Minimal structural shape of what we actually read off the React Query
 * `Query` object. Using the real `Query<TData, TError, ...>` type
 * propagates React Query's `TError = Error` default, which doesn't line
 * up with tRPC's `TRPCClientErrorLike<...>` error type — so the callback
 * ends up non-assignable to the query options. We don't care about
 * `TError` here; just the data. tRPC's real Query type narrows to this
 * shape structurally.
 */
interface QueryLike<TData> {
  // React Query types `state.data` as `TData | undefined`; tRPC
  // procedures whose handler returns `T | null` widen it to
  // `TData | null | undefined`. Accept both so a nullable endpoint
  // (e.g. analysis.lastFailure) can use the hook without a cast.
  state: { data: TData | null | undefined };
}

/**
 * Bounded-polling `refetchInterval` factory for React Query.
 *
 * Why this exists
 * ---------------
 * Several list queries in this app wait on an async BullMQ worker to
 * produce results (findings, risks, recommendations, scoring, etc.).
 * The obvious "set `refetchInterval: 4_000`" wires infinite polling —
 * when the worker never writes results (e.g. the Anthropic API is
 * rejecting the call), the UI keeps hammering the server forever.
 *
 * This hook returns a `refetchInterval` callback that stops polling
 * when either condition is true:
 *
 *   1. Results have landed — `isDone(data)` returns true.
 *   2. We've been waiting longer than `maxPollMs` (default 4 min).
 *
 * The caller supplies the `isDone` predicate since different queries
 * have different "I have data" signals:
 *
 *   - array query:      `(d) => Array.isArray(d) && d.length > 0`
 *   - summary object:   `(d) => d && (d.findings + d.risks + ...) > 0`
 *
 * Window-focus refetching (React Query default) still picks up new
 * data if the user comes back to the tab after polling has stopped,
 * so we don't lose responsiveness — we just stop wasting bandwidth.
 */
export function useBoundedPolling<TData>(opts: {
  isDone: (data: TData | null | undefined) => boolean;
  intervalMs?: number;
  maxPollMs?: number;
}) {
  const intervalMs = opts.intervalMs ?? 4_000;
  const maxPollMs = opts.maxPollMs ?? 4 * 60_000;
  const mountedAt = useRef(Date.now());

  return (query: QueryLike<TData>): number | false => {
    if (opts.isDone(query.state.data)) return false;
    if (Date.now() - mountedAt.current > maxPollMs) return false;
    return intervalMs;
  };
}
