import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetSettingsCacheForTests,
  getSetting,
  setSetting,
  SETTING_KEYS,
} from "./settings-service";

// Unit tests for the in-process cache + DB fallback semantics. The
// engine relies on these invariants:
//   - missing row → default returned, default cached
//   - write → local cache invalidated, next read sees the new value
//   - DB throw → default returned, never bubbled
// Prisma is stubbed as a minimal `setting` surface so the suite runs
// without docker.

interface FakeRow {
  key: string;
  valueJson: unknown;
}

function makeDb(rows: FakeRow[]) {
  const findUnique = vi.fn(async ({ where }: { where: { key: string } }) =>
    rows.find((r) => r.key === where.key) ?? null,
  );
  const upsert = vi.fn(async ({
    where,
    create,
    update,
  }: {
    where: { key: string };
    create: FakeRow;
    update: { valueJson: unknown };
  }) => {
    const existing = rows.find((r) => r.key === where.key);
    if (existing) existing.valueJson = update.valueJson;
    else rows.push({ key: create.key, valueJson: create.valueJson });
    return { key: where.key };
  });
  return { setting: { findUnique, upsert }, _findUnique: findUnique };
}

afterEach(() => {
  __resetSettingsCacheForTests();
  vi.useRealTimers();
});

describe("settings-service", () => {
  it("returns the default when the row is absent", async () => {
    const db = makeDb([]);
    const v = await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 1);
    expect(v).toBe(1);
  });

  it("caches reads within the TTL", async () => {
    const db = makeDb([{ key: SETTING_KEYS.analysisDomainConcurrency, valueJson: 4 }]);
    const a = await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 1);
    const b = await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 1);
    expect(a).toBe(4);
    expect(b).toBe(4);
    expect(db._findUnique).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.useFakeTimers();
    const db = makeDb([{ key: SETTING_KEYS.analysisDomainConcurrency, valueJson: 2 }]);
    await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 1);
    vi.advanceTimersByTime(11_000);
    await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 1);
    expect(db._findUnique).toHaveBeenCalledTimes(2);
  });

  it("setSetting invalidates the local cache so the next read sees the new value", async () => {
    const db = makeDb([{ key: SETTING_KEYS.analysisDomainConcurrency, valueJson: 2 }]);
    const first = await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 1);
    expect(first).toBe(2);
    await setSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 6, "user-1");
    const next = await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 1);
    expect(next).toBe(6);
    // Invalidation forces a second findUnique (not a third) because the
    // initial cached read counted as 1. Sanity-check the write path too.
    expect(db.setting.upsert).toHaveBeenCalledTimes(1);
  });

  it("falls back to default when the DB read throws", async () => {
    const db = {
      setting: {
        findUnique: vi.fn(async () => {
          throw new Error("db exploded");
        }),
        upsert: vi.fn(),
      },
    };
    const v = await getSetting(db as never, SETTING_KEYS.analysisDomainConcurrency, 3);
    expect(v).toBe(3);
  });
});
