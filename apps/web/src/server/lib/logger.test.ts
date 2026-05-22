import { describe, expect, it } from "vitest";
import { redactContext, pluckCorrelators } from "./logger";

describe("redactContext", () => {
  it("replaces sensitive keys case-insensitively", () => {
    const out = redactContext({
      username: "alice",
      password: "hunter2",
      Token: "abc",
      apiKey: "xyz",
      Authorization: "Bearer foo",
      COOKIE: "sid=123",
    }) as Record<string, string>;
    expect(out.username).toBe("alice");
    expect(out.password).toBe("[redacted]");
    expect(out.Token).toBe("[redacted]");
    expect(out.apiKey).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.COOKIE).toBe("[redacted]");
  });

  it("walks into nested objects and arrays", () => {
    const out = redactContext({
      level1: {
        token: "t",
        innocent: "yes",
        list: [{ apiKey: "k" }, "string"],
      },
    }) as { level1: { token: string; innocent: string; list: unknown[] } };
    expect(out.level1.token).toBe("[redacted]");
    expect(out.level1.innocent).toBe("yes");
    const item0 = out.level1.list[0] as { apiKey: string };
    expect(item0.apiKey).toBe("[redacted]");
    expect(out.level1.list[1]).toBe("string");
  });

  it("survives circular references", () => {
    const a: Record<string, unknown> = { name: "a", password: "p" };
    a.self = a;
    const out = redactContext(a) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect(out.password).toBe("[redacted]");
    // The recursive ref should be replaced with the sentinel, not recurse forever.
    expect(out.self).toBe("[circular]");
  });

  it("returns primitives unchanged", () => {
    expect(redactContext(null)).toBe(null);
    expect(redactContext(42)).toBe(42);
    expect(redactContext("hello")).toBe("hello");
    expect(redactContext(undefined)).toBe(undefined);
  });
});

describe("pluckCorrelators", () => {
  it("lifts known correlator keys from the context", () => {
    expect(
      pluckCorrelators({
        userId: "u1",
        assessmentId: "a1",
        jobId: "j1",
        unrelated: "x",
      }),
    ).toEqual({ userId: "u1", assessmentId: "a1", jobId: "j1" });
  });

  it("returns nulls when fields are missing or non-string", () => {
    expect(pluckCorrelators(undefined)).toEqual({
      userId: null,
      assessmentId: null,
      jobId: null,
    });
    expect(
      pluckCorrelators({ userId: 42 as unknown as string, jobId: "" }),
    ).toEqual({ userId: null, assessmentId: null, jobId: null });
  });
});
