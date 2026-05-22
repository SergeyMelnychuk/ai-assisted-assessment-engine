import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

// Stub the queue enqueue so reproposeBinding never tries to reach
// Redis from a unit test.
vi.mock("@/server/queue/queue", () => ({
  enqueueProposeTemplateBinding: vi.fn(async () => undefined),
}));

import { templateRouter } from "./template";
import type { Context } from "../trpc";

type Caller = ReturnType<typeof templateRouter.createCaller>;

// z.string().cuid() expects the legacy cuid shape: lowercase letter
// `c` followed by 24 base-32 chars. We don't need real entropy in
// tests; build deterministic 25-char strings keyed off a label so
// fixtures stay readable.
function cuid(label: string): string {
  // Fold label into 24 chars; pad with `a` and strip non-[a-z0-9].
  const cleaned = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ("c" + (cleaned + "aaaaaaaaaaaaaaaaaaaaaaaa").slice(0, 24));
}
const ID = {
  tplWs: cuid("tplworkspace"),
  tplEng: cuid("tplengagement"),
  tplOld: cuid("tplold"),
  tplNew: cuid("tplnew"),
  tplHasBinding: cuid("tplhas"),
  eng1: cuid("eng1"),
  engMine: cuid("engmine"),
  engOther: cuid("engother"),
  asmMine: cuid("asmmine"),
  asmOther: cuid("asmother"),
  uAdmin: cuid("uadmin"),
  uAssessor: cuid("uassessor"),
  uOwner: cuid("uowner"),
  uContrib: cuid("ucontrib"),
  uMem: cuid("umem"),
  uStranger: cuid("ustranger"),
};

// ─── Lightweight Prisma mock ───────────────────────────────────────
//
// The router only touches a handful of models. We back each table with
// a Map<id, row> and implement just the query shapes the router uses:
// findFirst, findUnique, findMany, update, updateMany, delete, create,
// $transaction (array form). Filtering supports the where clauses the
// router actually issues — id equality, engagementId, kind, status,
// archivedAt, OR pairs, and bindingJson != null. Anything beyond that
// would mean rewriting the router; if a test starts asking for more
// it's a sign the router is doing too much.

type Role = "ADMIN" | "ASSESSOR" | "REVIEWER" | "VIEWER";

interface TemplateRow {
  id: string;
  engagementId: string | null;
  kind: "ESTIMATION" | "DELIVERABLE_REPORT" | "DELIVERABLE_PRESENTATION";
  name: string;
  version: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  status: "PROPOSED" | "APPROVED" | "DEPRECATED";
  bindingJson: unknown | null;
  archivedAt: Date | null;
  approvedAt: Date | null;
  approvedById: string | null;
  deprecatedAt: Date | null;
  uploaderId: string;
  createdAt: Date;
  uploader?: { name: string | null; email: string };
  approver?: { name: string | null; email: string } | null;
}

interface EngagementRow {
  id: string;
}

interface MemberRow {
  id: string;
  engagementId: string;
  userId: string;
  role: "OWNER" | "CONTRIBUTOR" | "REVIEWER" | "VIEWER";
}

interface AssessmentRow {
  id: string;
  engagementId: string;
}

interface FillRow {
  id: string;
  templateId: string;
  assessmentId: string;
  filledAt: Date;
  outputDocumentId: string | null;
}

interface SetupOpts {
  role?: Role;
  userId?: string;
  templates?: TemplateRow[];
  engagements?: EngagementRow[];
  members?: MemberRow[];
  assessments?: AssessmentRow[];
  fills?: FillRow[];
  auditLogs?: Array<{
    entityId: string;
    action: string;
    details: unknown;
    createdAt: Date;
  }>;
}

interface World {
  templates: Map<string, TemplateRow>;
  engagements: Map<string, EngagementRow>;
  members: Map<string, MemberRow>;
  assessments: Map<string, AssessmentRow>;
  fills: Map<string, FillRow>;
  auditCreates: Array<Record<string, unknown>>;
  auditExisting: Array<{
    entityId: string;
    action: string;
    details: unknown;
    createdAt: Date;
  }>;
}

function makeWorld(opts: SetupOpts): World {
  const w: World = {
    templates: new Map(),
    engagements: new Map(),
    members: new Map(),
    assessments: new Map(),
    fills: new Map(),
    auditCreates: [],
    auditExisting: opts.auditLogs ?? [],
  };
  (opts.templates ?? []).forEach((t) => w.templates.set(t.id, { ...t }));
  (opts.engagements ?? []).forEach((e) => w.engagements.set(e.id, { ...e }));
  (opts.members ?? []).forEach((m) => w.members.set(m.id, { ...m }));
  (opts.assessments ?? []).forEach((a) => w.assessments.set(a.id, { ...a }));
  (opts.fills ?? []).forEach((f) => w.fills.set(f.id, { ...f }));
  return w;
}

// Match "user is in members of engagement E" or admin-bypass that the
// router relies on. We re-implement the same predicate here rather
// than import it — the goal is to verify the router behaves correctly
// against a Prisma boundary, not retest the helper.
function engagementVisibleTo(
  w: World,
  session: { user: { id: string; role: Role } },
  engagementId: string,
): boolean {
  if (!w.engagements.has(engagementId)) return false;
  if (session.user.role === "ADMIN") return true;
  for (const m of w.members.values()) {
    if (m.engagementId === engagementId && m.userId === session.user.id) {
      return true;
    }
  }
  return false;
}

function makeCtx(opts: SetupOpts): { ctx: Context; world: World } {
  const role = opts.role ?? "ADMIN";
  const userId = opts.userId ?? ID.uAdmin;
  const world = makeWorld(opts);

  const session = {
    user: { id: userId, role },
    expires: "2099-01-01T00:00:00.000Z",
  };

  const db = {
    engagement: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        const id = args.where.id;
        if (engagementVisibleTo(world, session as never, id)) {
          return { id };
        }
        return null;
      }),
    },
    template: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return world.templates.get(args.where.id) ?? null;
      }),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        for (const t of world.templates.values()) {
          if (matchTemplateWhere(t, args.where)) return t;
        }
        return null;
      }),
      findMany: vi.fn(
        async (args: {
          where?: Record<string, unknown>;
          orderBy?: unknown;
          include?: unknown;
          select?: unknown;
        }) => {
          const where = args.where ?? {};
          const rows = Array.from(world.templates.values()).filter((t) =>
            matchTemplateWhere(t, where),
          );
          // Order: kind asc, createdAt desc — only used by `list`.
          rows.sort((a, b) => {
            if (a.kind === b.kind) {
              return b.createdAt.getTime() - a.createdAt.getTime();
            }
            return a.kind < b.kind ? -1 : 1;
          });
          // For pickerOptions: engagementId desc then approvedAt desc.
          // Detect by orderBy shape if present.
          const ob = args.orderBy as
            | Array<Record<string, "asc" | "desc">>
            | undefined;
          if (ob && ob[0]?.engagementId) {
            rows.sort((a, b) => {
              const ae = a.engagementId === null ? 0 : 1;
              const be = b.engagementId === null ? 0 : 1;
              if (ae !== be) return be - ae; // desc
              const at = a.approvedAt?.getTime() ?? 0;
              const bt = b.approvedAt?.getTime() ?? 0;
              return bt - at;
            });
          }
          return rows;
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Partial<TemplateRow>;
        }) => {
          const cur = world.templates.get(args.where.id);
          if (!cur) throw new Error("not found");
          const next = { ...cur, ...args.data };
          world.templates.set(args.where.id, next);
          return next;
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Partial<TemplateRow>;
        }) => {
          let count = 0;
          for (const [id, t] of world.templates.entries()) {
            if (matchTemplateWhere(t, args.where)) {
              world.templates.set(id, { ...t, ...args.data });
              count++;
            }
          }
          return { count };
        },
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const cur = world.templates.get(args.where.id);
        if (!cur) throw new Error("not found");
        world.templates.delete(args.where.id);
        return cur;
      }),
    },
    engagementMember: {
      findFirst: vi.fn(
        async (args: {
          where: { engagementId: string; userId: string; role?: string };
        }) => {
          for (const m of world.members.values()) {
            if (
              m.engagementId === args.where.engagementId &&
              m.userId === args.where.userId &&
              (!args.where.role || m.role === args.where.role)
            ) {
              return m;
            }
          }
          return null;
        },
      ),
    },
    auditLog: {
      findMany: vi.fn(
        async (args: {
          where: {
            entityId: { in: string[] };
            action: { in: string[] };
          };
          orderBy?: unknown;
          select?: unknown;
        }) => {
          const ids = new Set(args.where.entityId.in);
          const actions = new Set(args.where.action.in);
          return world.auditExisting
            .filter((e) => ids.has(e.entityId) && actions.has(e.action))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        },
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        world.auditCreates.push(args.data);
        return args.data;
      }),
    },
    templateFill: {
      findMany: vi.fn(
        async (args: {
          where: {
            templateId?: string;
            assessment?: { engagement?: unknown };
            assessmentId?: string;
            outputDocumentId?: { not: null };
          };
        }) => {
          // For the `fills` test we only use the templateId + assessment-
          // gated flavour. Match by templateId; gate by membership through
          // the assessment's engagement.
          const w = args.where;
          const out: FillRow[] = [];
          for (const f of world.fills.values()) {
            if (w.templateId && f.templateId !== w.templateId) continue;
            if (w.outputDocumentId?.not === null && f.outputDocumentId === null)
              continue;
            const asm = world.assessments.get(f.assessmentId);
            if (!asm) continue;
            if (!engagementVisibleTo(world, session as never, asm.engagementId))
              continue;
            out.push(f);
          }
          return out
            .sort((a, b) => b.filledAt.getTime() - a.filledAt.getTime())
            .map((f) => ({
              ...f,
              outputDocument: f.outputDocumentId
                ? { id: f.outputDocumentId, filename: "x.xlsx", fileSize: 1 }
                : null,
              assessment: { id: f.assessmentId, mode: "STANDARD" },
            }));
        },
      ),
    },
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => {
      // Router only uses array-form $transaction for `approve`.
      return Promise.all(ops);
    }),
  };

  return {
    ctx: {
      db: db as unknown as Context["db"],
      session: session as unknown as Context["session"],
    },
    world,
  };
}

function matchTemplateWhere(
  t: TemplateRow,
  where: Record<string, unknown>,
): boolean {
  // Accept a small set of shapes the router uses.
  for (const [k, v] of Object.entries(where)) {
    if (k === "id") {
      if (typeof v === "string" && t.id !== v) return false;
      if (
        v &&
        typeof v === "object" &&
        "not" in (v as Record<string, unknown>) &&
        t.id === (v as { not: string }).not
      )
        return false;
    } else if (k === "engagementId") {
      if (v === null && t.engagementId !== null) return false;
      if (typeof v === "string" && t.engagementId !== v) return false;
    } else if (k === "kind") {
      if (v && t.kind !== v) return false;
    } else if (k === "status") {
      if (v && t.status !== v) return false;
    } else if (k === "archivedAt") {
      if (v === null && t.archivedAt !== null) return false;
    } else if (k === "name") {
      if (typeof v === "string" && t.name !== v) return false;
    } else if (k === "bindingJson") {
      // { not: Prisma.DbNull } shape — accept any non-null binding.
      if (
        v &&
        typeof v === "object" &&
        "not" in (v as Record<string, unknown>) &&
        t.bindingJson === null
      ) {
        return false;
      }
    } else if (k === "OR") {
      const branches = v as Array<Record<string, unknown>>;
      const ok = branches.some((b) => matchTemplateWhere(t, b));
      if (!ok) return false;
    } else if (k === "NOT") {
      const inner = v as Record<string, unknown>;
      if (matchTemplateWhere(t, inner)) return false;
    }
    // Unknown keys are ignored — keeps the matcher tolerant of richer
    // where clauses without rewriting per test.
  }
  return true;
}

function caller(ctx: Context): Caller {
  return templateRouter.createCaller(ctx);
}

// ─── Helpers / fixtures ────────────────────────────────────────────

function tpl(over: Partial<TemplateRow> & { id: string }): TemplateRow {
  return {
    id: over.id,
    engagementId: over.engagementId ?? null,
    kind: over.kind ?? "ESTIMATION",
    name: over.name ?? "WBS",
    version: over.version ?? "1.0",
    filename: over.filename ?? "wbs.xlsx",
    mimeType:
      over.mimeType ??
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileSize: over.fileSize ?? 1234,
    status: over.status ?? "PROPOSED",
    bindingJson: over.bindingJson ?? null,
    archivedAt: over.archivedAt ?? null,
    approvedAt: over.approvedAt ?? null,
    approvedById: over.approvedById ?? null,
    deprecatedAt: over.deprecatedAt ?? null,
    uploaderId: over.uploaderId ?? ID.uAdmin,
    createdAt: over.createdAt ?? new Date("2026-01-01"),
    uploader: { name: "Up", email: "up@example.com" },
    approver: null,
  };
}

const VALID_BINDING = {
  version: 1 as const,
  templateKind: "ESTIMATION" as const,
  entries: [
    {
      field: "project.name",
      target: { kind: "xlsx.cell", sheet: "Cover", cell: "B1" } as const,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── list ──────────────────────────────────────────────────────────

describe("template.list", () => {
  it("returns workspace defaults to a non-admin authenticated user", async () => {
    const { ctx } = makeCtx({
      role: "ASSESSOR",
      userId: ID.uAssessor,
      templates: [
        tpl({ id: ID.tplWs, engagementId: null, status: "APPROVED" }),
      ],
    });
    const rows = await caller(ctx).list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ID.tplWs);
    expect(rows[0]?.scope).toBe("workspace");
  });

  it("rejects engagement-scoped list for users without engagement access", async () => {
    const { ctx } = makeCtx({
      role: "ASSESSOR",
      userId: ID.uStranger,
      engagements: [{ id: ID.eng1 }],
      members: [], // user is not a member
      templates: [
        tpl({ id: ID.tplEng, engagementId: ID.eng1, status: "APPROVED" }),
      ],
    });
    await expect(
      caller(ctx).list({ engagementId: ID.eng1 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

// ─── saveBinding authz ─────────────────────────────────────────────

describe("template.saveBinding authz", () => {
  it("denies workspace-default mutation for non-admin", async () => {
    const { ctx } = makeCtx({
      role: "ASSESSOR",
      userId: ID.uAssessor,
      templates: [tpl({ id: ID.tplWs, engagementId: null })],
    });
    await expect(
      caller(ctx).saveBinding({ id: ID.tplWs, binding: VALID_BINDING }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies engagement-scoped mutation for non-OWNER non-admin", async () => {
    const { ctx } = makeCtx({
      role: "ASSESSOR",
      userId: ID.uContrib,
      engagements: [{ id: ID.eng1 }],
      members: [
        // Member of the engagement, but only as REVIEWER — not OWNER.
        {
          id: "m-1",
          engagementId: ID.eng1,
          userId: ID.uContrib,
          role: "REVIEWER",
        },
      ],
      templates: [tpl({ id: ID.tplEng, engagementId: ID.eng1 })],
    });
    await expect(
      caller(ctx).saveBinding({ id: ID.tplEng, binding: VALID_BINDING }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows workspace-default mutation for ADMIN", async () => {
    const { ctx, world } = makeCtx({
      role: "ADMIN",
      userId: ID.uAdmin,
      templates: [tpl({ id: ID.tplWs, engagementId: null })],
    });
    const out = await caller(ctx).saveBinding({
      id: ID.tplWs,
      binding: VALID_BINDING,
    });
    expect(out).toEqual({ ok: true });
    expect(world.templates.get(ID.tplWs)?.bindingJson).toBeTruthy();
    expect(world.auditCreates.some((a) => a.action === "TEMPLATE_BINDING_SAVED"))
      .toBe(true);
  });

  it("allows engagement-scoped mutation for OWNER", async () => {
    const { ctx } = makeCtx({
      role: "ASSESSOR",
      userId: ID.uOwner,
      engagements: [{ id: ID.eng1 }],
      members: [
        {
          id: "m-1",
          engagementId: ID.eng1,
          userId: ID.uOwner,
          role: "OWNER",
        },
      ],
      templates: [tpl({ id: ID.tplEng, engagementId: ID.eng1 })],
    });
    const out = await caller(ctx).saveBinding({
      id: ID.tplEng,
      binding: VALID_BINDING,
    });
    expect(out).toEqual({ ok: true });
  });
});

// ─── approve auto-deprecation ──────────────────────────────────────

describe("template.approve", () => {
  it("auto-deprecates older approved versions of the same name", async () => {
    const { ctx, world } = makeCtx({
      role: "ADMIN",
      templates: [
        tpl({
          id: ID.tplOld,
          engagementId: null,
          name: "WBS",
          status: "APPROVED",
          bindingJson: VALID_BINDING,
          approvedAt: new Date("2026-01-01"),
        }),
        tpl({
          id: ID.tplNew,
          engagementId: null,
          name: "WBS",
          status: "APPROVED",
          bindingJson: VALID_BINDING,
          approvedAt: new Date("2026-02-01"),
        }),
      ],
    });
    await caller(ctx).approve({ id: ID.tplNew });
    expect(world.templates.get(ID.tplOld)?.status).toBe("DEPRECATED");
    expect(world.templates.get(ID.tplOld)?.deprecatedAt).toBeInstanceOf(Date);
    expect(world.templates.get(ID.tplNew)?.status).toBe("APPROVED");
    expect(world.auditCreates.some((a) => a.action === "TEMPLATE_APPROVED"))
      .toBe(true);
  });
});

// ─── reproposeBinding ──────────────────────────────────────────────

describe("template.reproposeBinding", () => {
  it("rejects when bindingJson already present", async () => {
    const { ctx } = makeCtx({
      role: "ADMIN",
      templates: [
        tpl({
          id: ID.tplHasBinding,
          engagementId: null,
          bindingJson: VALID_BINDING,
        }),
      ],
    });
    await expect(
      caller(ctx).reproposeBinding({ id: ID.tplHasBinding }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ─── pickerOptions ─────────────────────────────────────────────────

describe("template.pickerOptions", () => {
  it("orders engagement-scoped first and flags isDefault on the first row", async () => {
    const { ctx } = makeCtx({
      role: "ADMIN",
      engagements: [{ id: ID.eng1 }],
      templates: [
        tpl({
          id: ID.tplWs,
          engagementId: null,
          status: "APPROVED",
          bindingJson: VALID_BINDING,
          approvedAt: new Date("2026-04-01"),
        }),
        tpl({
          id: ID.tplEng,
          engagementId: ID.eng1,
          status: "APPROVED",
          bindingJson: VALID_BINDING,
          approvedAt: new Date("2026-01-01"),
        }),
      ],
    });
    const out = await caller(ctx).pickerOptions({
      engagementId: ID.eng1,
      kind: "ESTIMATION",
    });
    expect(out.length).toBe(2);
    // Engagement-scoped row wins precedence even though its approval is older.
    expect(out[0]?.id).toBe(ID.tplEng);
    expect(out[0]?.isDefault).toBe(true);
    expect(out[1]?.id).toBe(ID.tplWs);
    expect(out[1]?.isDefault).toBe(false);
  });
});

// ─── fills (assessment-scoped visibility) ──────────────────────────

describe("template.fills", () => {
  it("scopes returned fills via assessment engagement membership", async () => {
    const { ctx } = makeCtx({
      role: "ASSESSOR",
      userId: ID.uMem,
      engagements: [{ id: ID.engMine }, { id: ID.engOther }],
      members: [
        {
          id: "m1",
          engagementId: ID.engMine,
          userId: ID.uMem,
          role: "REVIEWER",
        },
      ],
      assessments: [
        { id: ID.asmMine, engagementId: ID.engMine },
        { id: ID.asmOther, engagementId: ID.engOther },
      ],
      templates: [tpl({ id: ID.tplWs, engagementId: null })],
      fills: [
        {
          id: "f-mine",
          templateId: ID.tplWs,
          assessmentId: ID.asmMine,
          filledAt: new Date("2026-05-01"),
          outputDocumentId: "doc-1",
        },
        {
          id: "f-other",
          templateId: ID.tplWs,
          assessmentId: ID.asmOther,
          filledAt: new Date("2026-05-02"),
          outputDocumentId: "doc-2",
        },
      ],
    });
    const rows = await caller(ctx).fills({ templateId: ID.tplWs });
    expect(rows.map((r) => r.id)).toEqual(["f-mine"]);
  });
});
