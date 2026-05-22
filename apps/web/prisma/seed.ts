import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

// Where the @copilot/knowledge-seed package lives, relative to this file
// (apps/web/prisma → packages/knowledge-seed).
const KNOWLEDGE_SEED_DIR = path.resolve(
  __dirname,
  "../../../packages/knowledge-seed",
);

// Dev-only default. Override via env before seeding, e.g.
//   ADMIN_SEED_PASSWORD='mybetter-password' pnpm db:seed
const ADMIN_SEED_PASSWORD = process.env.ADMIN_SEED_PASSWORD ?? "admin123";

async function main() {
  console.log("Seeding database...");

  // Create default assessment types
  const architectureAssessment = await prisma.assessmentType.upsert({
    where: { name: "Architecture Assessment" },
    update: {},
    create: {
      name: "Architecture Assessment",
      description:
        "Comprehensive review of an existing software architecture to identify strengths, weaknesses, risks, and improvement opportunities",
      defaultDomains: [
        "business_context",
        "architecture",
        "security_iam",
        "integrations_apis",
        "cloud_infrastructure",
        "devops_cicd",
        "observability",
        "nfrs",
      ],
      defaultMode: "EXISTING_SYSTEM",
    },
  });

  const discovery = await prisma.assessmentType.upsert({
    where: { name: "Discovery" },
    update: {},
    create: {
      name: "Discovery",
      description:
        "Pre-implementation discovery to clarify scope, architecture direction, team composition, and effort estimation",
      defaultDomains: [
        "business_context",
        "functional_scope",
        "architecture",
        "nfrs",
        "integrations_apis",
        "delivery_strategy",
        "cloud_infrastructure",
        "risks_constraints",
      ],
      defaultMode: "PRE_IMPLEMENTATION",
    },
  });

  const modernization = await prisma.assessmentType.upsert({
    where: { name: "Modernization Assessment" },
    update: {},
    create: {
      name: "Modernization Assessment",
      description:
        "Assessment of readiness and risks for platform modernization, migration, or transformation",
      defaultDomains: [
        "business_context",
        "architecture",
        "cloud_infrastructure",
        "devops_cicd",
        "integrations_apis",
        "nfrs",
        "observability",
        "security_iam",
      ],
      defaultMode: "MODERNIZATION",
    },
  });

  const auditReadiness = await prisma.assessmentType.upsert({
    where: { name: "Audit / Readiness Review" },
    update: {},
    create: {
      name: "Audit / Readiness Review",
      description:
        "Structured readiness check before implementation, scale-up, compliance work, or operational hardening",
      defaultDomains: [
        "business_context",
        "architecture",
        "security_iam",
        "devops_cicd",
        "cloud_infrastructure",
        "observability",
        "nfrs",
      ],
      defaultMode: "AUDIT",
    },
  });

  console.log("Assessment types seeded:", {
    architectureAssessment: architectureAssessment.id,
    discovery: discovery.id,
    modernization: modernization.id,
    auditReadiness: auditReadiness.id,
  });

  // Load the default rate card rates from the knowledge-seed JSON — single
  // source of truth, so rate changes ship as data without touching code.
  const rateCardJsonPath = path.join(
    KNOWLEDGE_SEED_DIR,
    "rate-cards",
    "default-rate-card.json",
  );
  const rateCardJson = JSON.parse(fs.readFileSync(rateCardJsonPath, "utf8")) as {
    name: string;
    currency: string;
    rates: Array<{ role: string; seniority: string; hourlyRate: number; dailyRate: number }>;
  };
  const rateCard = await prisma.rateCard.upsert({
    where: { id: "default-rate-card" },
    update: {
      name: rateCardJson.name,
      currency: rateCardJson.currency,
      rates: rateCardJson.rates,
    },
    create: {
      id: "default-rate-card",
      name: rateCardJson.name,
      currency: rateCardJson.currency,
      rates: rateCardJson.rates,
      validFrom: new Date("2026-01-01"),
      isDefault: true,
    },
  });

  console.log(
    `Rate card seeded: ${rateCard.id} (${rateCardJson.rates.length} rates)`,
  );

  // Demo admin user. Password defaults to "admin123" (dev only — change it
  // for anything that leaves your laptop). Re-seeding updates the hash so the
  // admin account is always usable with the current seed password.
  const adminPasswordHash = await bcrypt.hash(ADMIN_SEED_PASSWORD, 12);
  const adminUser = await prisma.user.upsert({
    where: { email: "admin@copilot.dev" },
    update: { passwordHash: adminPasswordHash },
    create: {
      email: "admin@copilot.dev",
      name: "Admin User",
      passwordHash: adminPasswordHash,
      role: "ADMIN",
    },
  });

  console.log(
    `Admin user seeded: ${adminUser.email} (password: ${ADMIN_SEED_PASSWORD})`,
  );

  await seedQuestionTemplates();
  await seedRiskPatterns();
  await seedFrameworks();
  await seedRoleCatalog();
  await seedWorkspaceTemplates(adminUser.id);

  console.log("Seeding complete.");
}

// Load every question-template JSON from the knowledge-seed package and
// upsert it as a `KnowledgeArtifact` row with `artifactType=QUESTION_TEMPLATE`.
// The file name and the `name` field inside each JSON are treated as the
// stable id — re-running the seed updates in place rather than duplicating.
async function seedQuestionTemplates() {
  const dir = path.join(KNOWLEDGE_SEED_DIR, "question-templates");
  if (!fs.existsSync(dir)) {
    console.warn(`Question-template dir missing: ${dir} — skipping`);
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let count = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const parsed = JSON.parse(raw) as {
      domain: string;
      name: string;
      description?: string;
      questions: unknown[];
    };
    if (
      !parsed.domain ||
      !parsed.name ||
      !Array.isArray(parsed.questions)
    ) {
      console.warn(`  skipping ${file} — missing required fields`);
      continue;
    }

    // Find-or-create: there's no unique index on (artifactType,name) in
    // the schema, so we look up by name and update/create explicitly.
    const existing = await prisma.knowledgeArtifact.findFirst({
      where: { artifactType: "QUESTION_TEMPLATE", name: parsed.name },
      select: { id: true, version: true },
    });

    if (existing) {
      await prisma.knowledgeArtifact.update({
        where: { id: existing.id },
        data: {
          description: parsed.description ?? "",
          content: parsed as object,
          domain: parsed.domain,
          isActive: true,
          version: existing.version + 1,
        },
      });
    } else {
      await prisma.knowledgeArtifact.create({
        data: {
          artifactType: "QUESTION_TEMPLATE",
          name: parsed.name,
          description: parsed.description ?? "",
          content: parsed as object,
          domain: parsed.domain,
          tags: [parsed.domain, "baseline"],
        },
      });
    }
    count += 1;
  }
  console.log(`Question templates seeded: ${count}`);
}

/**
 * Risk-pattern catalogs drive the analysis engine's prompt context. Each
 * file contributes one `KnowledgeArtifact` row per pattern so the analysis
 * service can vector/tag-filter them later; for now we store flat by name.
 */
async function seedRiskPatterns() {
  const dir = path.join(KNOWLEDGE_SEED_DIR, "risk-patterns");
  if (!fs.existsSync(dir)) {
    console.warn(`Risk-pattern dir missing: ${dir} — skipping`);
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let count = 0;
  for (const file of files) {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, file), "utf8"),
    ) as { patterns?: Array<{ id: string; title: string; domain: string }> };
    if (!Array.isArray(parsed.patterns)) continue;

    for (const pattern of parsed.patterns) {
      const name = `risk.${pattern.id}`;
      const existing = await prisma.knowledgeArtifact.findFirst({
        where: { artifactType: "RISK_PATTERN", name },
        select: { id: true, version: true },
      });
      if (existing) {
        await prisma.knowledgeArtifact.update({
          where: { id: existing.id },
          data: {
            description: pattern.title,
            content: pattern as object,
            domain: pattern.domain,
            isActive: true,
            version: existing.version + 1,
          },
        });
      } else {
        await prisma.knowledgeArtifact.create({
          data: {
            artifactType: "RISK_PATTERN",
            name,
            description: pattern.title,
            content: pattern as object,
            domain: pattern.domain,
            tags: [pattern.domain, "risk-pattern"],
          },
        });
      }
      count += 1;
    }
  }
  console.log(`Risk patterns seeded: ${count}`);
}

/**
 * Assessment frameworks carry the scoring rubric (1–5 maturity levels per
 * domain). One row per framework file — the scoring service looks up the
 * applicable framework via the artifact name.
 */
async function seedFrameworks() {
  const dir = path.join(KNOWLEDGE_SEED_DIR, "frameworks");
  if (!fs.existsSync(dir)) {
    console.warn(`Framework dir missing: ${dir} — skipping`);
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let count = 0;
  for (const file of files) {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, file), "utf8"),
    ) as { name: string; description?: string };
    if (!parsed.name) continue;

    const name = `framework.${path.basename(file, ".json")}`;
    const existing = await prisma.knowledgeArtifact.findFirst({
      where: { artifactType: "FRAMEWORK", name },
      select: { id: true, version: true },
    });
    if (existing) {
      await prisma.knowledgeArtifact.update({
        where: { id: existing.id },
        data: {
          description: parsed.description ?? parsed.name,
          content: parsed as object,
          isActive: true,
          version: existing.version + 1,
        },
      });
    } else {
      await prisma.knowledgeArtifact.create({
        data: {
          artifactType: "FRAMEWORK",
          name,
          description: parsed.description ?? parsed.name,
          content: parsed as object,
          tags: ["framework"],
        },
      });
    }
    count += 1;
  }
  console.log(`Frameworks seeded: ${count}`);
}

/**
 * Role catalog — feeds the estimation engine so Claude can pick from a
 * curated menu of roles/seniorities rather than improvising. Stored as a
 * single ROLE_CATALOG artifact; the estimation service looks it up by
 * name.
 */
async function seedRoleCatalog() {
  const filePath = path.join(
    KNOWLEDGE_SEED_DIR,
    "role-catalog",
    "standard-roles.json",
  );
  if (!fs.existsSync(filePath)) {
    console.warn(`Role catalog missing: ${filePath} — skipping`);
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    name: string;
    description?: string;
    roles: unknown[];
  };
  const name = "role_catalog.standard";
  const existing = await prisma.knowledgeArtifact.findFirst({
    where: { artifactType: "ROLE_CATALOG", name },
    select: { id: true, version: true },
  });
  if (existing) {
    await prisma.knowledgeArtifact.update({
      where: { id: existing.id },
      data: {
        description: parsed.description ?? parsed.name,
        content: parsed as object,
        isActive: true,
        version: existing.version + 1,
      },
    });
  } else {
    await prisma.knowledgeArtifact.create({
      data: {
        artifactType: "ROLE_CATALOG",
        name,
        description: parsed.description ?? parsed.name,
        content: parsed as object,
        tags: ["roles", "estimation"],
      },
    });
  }
  console.log(
    `Role catalog seeded: ${name} (${Array.isArray(parsed.roles) ? parsed.roles.length : 0} roles)`,
  );
}

/**
 * Workspace-default templates — packaged with the repo so a fresh
 * install ships with a usable WBS straight away. We upsert the
 * `Template` row and push the file to MinIO if it's reachable; if
 * MinIO is offline at seed time we still create the row (the
 * `proposed-template-binding` worker will re-load the file on demand
 * when the AI proposer runs against it).
 *
 * Idempotent: keyed on `(name, version, engagementId=null, kind)`
 * so re-running seed against an existing DB doesn't stack duplicates.
 *
 * Two folders are scanned:
 *   - `estimation-templates/` — the original WBS workbook (one fixed
 *     pair of files, kept as-is for back-compat).
 *   - `deliverable-shells/`   — any number of `<slug>-v<N>.<ext>` +
 *     `<slug>-v<N>.binding.json` pairs. Each binding's `notes` may
 *     embed a `seed: { ... }` JSON fragment that overrides the
 *     filename-derived display name / version / kind.
 */
async function seedWorkspaceTemplates(adminUserId: string) {
  const TEMPLATES_DIR = path.join(KNOWLEDGE_SEED_DIR, "estimation-templates");
  const wbsPath = path.join(TEMPLATES_DIR, "wbs-and-estimates-v1.5.xlsx");
  const bindingPath = path.join(
    TEMPLATES_DIR,
    "wbs-and-estimates-v1.5.binding.json",
  );
  if (fs.existsSync(wbsPath)) {
    await upsertWorkspaceTemplate({
      adminUserId,
      filePath: wbsPath,
      bindingPath,
      name: "WBS and Estimates",
      version: "v1.5",
      kind: "ESTIMATION",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  } else {
    console.warn(
      `[seed] workspace template not found at ${wbsPath} — skipping.`,
    );
  }

  await seedDeliverableShells(adminUserId);
}

/**
 * Walk `packages/knowledge-seed/deliverable-shells/`, pairing each
 * `<slug>-v<N>.binding.json` with its sibling binary file (xlsx /
 * docx / pptx). Skips silently when the folder doesn't exist so
 * older checkouts keep working.
 */
async function seedDeliverableShells(adminUserId: string) {
  const dir = path.join(KNOWLEDGE_SEED_DIR, "deliverable-shells");
  if (!fs.existsSync(dir)) return;

  const bindingFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".binding.json"))
    .sort();
  if (bindingFiles.length === 0) return;

  for (const bindingFile of bindingFiles) {
    const bindingPath = path.join(dir, bindingFile);
    const slugWithVersion = bindingFile.replace(/\.binding\.json$/, "");
    const filePath = findSiblingBinary(dir, slugWithVersion);
    if (!filePath) {
      console.warn(
        `[seed] deliverable-shells: no .xlsx/.docx/.pptx sibling for ${bindingFile} — skipping.`,
      );
      continue;
    }
    const meta = parseSeedMeta(bindingPath, slugWithVersion);
    await upsertWorkspaceTemplate({
      adminUserId,
      filePath,
      bindingPath,
      name: meta.name,
      version: meta.version,
      kind: meta.kind,
      mimeType: meta.mimeType,
    });
  }
}

const TEMPLATE_BINARY_EXTS = [".xlsx", ".docx", ".pptx"] as const;
const MIME_BY_EXT: Record<string, string> = {
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function findSiblingBinary(dir: string, basename: string): string | null {
  for (const ext of TEMPLATE_BINARY_EXTS) {
    const candidate = path.join(dir, `${basename}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

type SeedMeta = {
  name: string;
  version: string;
  kind: TemplateKindLiteral;
  mimeType: string;
};

// Mirror of the `templateKind` enum in the binding schema. Anything
// the binding accepts is also a valid `Template.kind` value.
type TemplateKindLiteral =
  | "ESTIMATION"
  | "DELIVERABLE_REPORT"
  | "DELIVERABLE_PRESENTATION"
  | "EXECUTIVE_SUMMARY"
  | "ASSESSMENT_REPORT"
  | "RISK_REGISTER"
  | "TARGET_STATE"
  | "ROADMAP"
  | "TEAM_PROPOSAL"
  | "ESTIMATE"
  | "ASSUMPTIONS_GAPS"
  | "SOW_DRAFT"
  | "GREENFIELD_DISCOVERY";

/**
 * Resolve display name / version / kind for a deliverable-shell
 * pair. Priority: explicit `seed: { ... }` JSON fragment in the
 * binding's `notes` → derive from filename + binding's
 * `templateKind`.
 */
function parseSeedMeta(
  bindingPath: string,
  slugWithVersion: string,
): SeedMeta {
  const ext = path.extname(
    findSiblingBinary(path.dirname(bindingPath), slugWithVersion) ?? "",
  );
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";

  // Filename-derived defaults: "<slug>-v<x>" → name: title-cased slug,
  // version: "v<x>". The slug itself may contain dashes.
  const match = slugWithVersion.match(/^(.+)-v([\w.]+)$/);
  const slug = match ? match[1] : slugWithVersion;
  const versionFromFile = match ? `v${match[2]}` : "v1";
  const nameFromFile = slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

  let kindFromBinding: TemplateKindLiteral | null = null;
  let notes = "";
  try {
    const raw = JSON.parse(fs.readFileSync(bindingPath, "utf8")) as {
      templateKind?: TemplateKindLiteral;
      notes?: string;
    };
    kindFromBinding = raw.templateKind ?? null;
    notes = raw.notes ?? "";
  } catch {
    // Validation happens later in upsertWorkspaceTemplate. If JSON
    // parsing fails here we just fall through to filename defaults.
  }

  // Pull the optional `seed: { ... }` JSON fragment out of `notes`.
  // Single-pair braces only — keep the regex deliberately simple.
  const seedMatch = notes.match(/seed:\s*(\{[^}]+\})/);
  if (seedMatch) {
    try {
      const parsed = JSON.parse(seedMatch[1]) as {
        name?: string;
        version?: string;
        kind?: TemplateKindLiteral;
      };
      return {
        name: parsed.name ?? nameFromFile,
        version: parsed.version ?? versionFromFile,
        kind: parsed.kind ?? kindFromBinding ?? "DELIVERABLE_REPORT",
        mimeType,
      };
    } catch {
      // Fall through to filename + binding defaults.
    }
  }

  return {
    name: nameFromFile,
    version: versionFromFile,
    kind: kindFromBinding ?? "DELIVERABLE_REPORT",
    mimeType,
  };
}

/**
 * Upsert one workspace-default template + push its file to MinIO
 * (best-effort). Keyed on `(name, version, engagementId=null, kind)`.
 */
async function upsertWorkspaceTemplate(args: {
  adminUserId: string;
  filePath: string;
  bindingPath: string;
  name: string;
  version: string;
  kind: TemplateKindLiteral;
  mimeType: string;
}) {
  const { adminUserId, filePath, bindingPath, name, version, kind, mimeType } =
    args;
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);

  // Load + validate the hand-authored binding sidecar. If it's missing
  // or malformed we fall back to the legacy PROPOSED behaviour rather
  // than blocking seed entirely.
  let bindingJson: unknown = null;
  let approveOnSeed = false;
  if (fs.existsSync(bindingPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
      const { bindingDocumentSchema } = await import(
        "../src/server/services/template/binding"
      );
      const parsed = bindingDocumentSchema.safeParse(raw);
      if (parsed.success) {
        bindingJson = parsed.data;
        approveOnSeed = true;
      } else {
        console.warn(
          `[seed] workspace template binding failed schema validation (${filename}): ${parsed.error.message}`,
        );
      }
    } catch (err) {
      console.warn(
        `[seed] could not load workspace template binding (${filename}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    console.warn(
      `[seed] no binding sidecar at ${bindingPath} — template will stay in PROPOSED.`,
    );
  }

  // Idempotent insert — Prisma doesn't have a composite upsert without
  // a @@unique, and we deliberately don't have one on
  // (name, version, engagementId) because per-engagement same-version
  // re-uploads are legitimate.
  const existing = await prisma.template.findFirst({
    where: { name, version, engagementId: null, kind },
    select: { id: true },
  });

  let templateId: string;
  if (existing) {
    templateId = existing.id;
    // Refresh the binding + approval stamp on every seed run so the
    // hand-authored sidecar is the source of truth.
    if (approveOnSeed) {
      await prisma.template.update({
        where: { id: templateId },
        data: {
          bindingJson: bindingJson as never,
          status: "APPROVED",
          approvedById: adminUserId,
          approvedAt: new Date(),
        },
      });
    }
  } else {
    const created = await prisma.template.create({
      data: {
        engagementId: null,
        kind,
        name,
        version,
        filename,
        mimeType,
        fileSize: buf.byteLength,
        storagePath: "pending",
        status: approveOnSeed ? "APPROVED" : "PROPOSED",
        uploadedById: adminUserId,
        ...(approveOnSeed
          ? {
              bindingJson: bindingJson as never,
              approvedById: adminUserId,
              approvedAt: new Date(),
            }
          : {}),
      },
      select: { id: true },
    });
    templateId = created.id;
  }

  // Push to MinIO, but don't block seed on a connection failure —
  // dev environments often run seed before MinIO is up.
  const key = `templates/${templateId}/${filename}`;
  try {
    const { putObject } = await import("../src/server/storage/minio");
    await putObject(key, buf, mimeType);
    await prisma.template.update({
      where: { id: templateId },
      data: { storagePath: key },
    });
    console.log(`Workspace template seeded: ${name} (${version})`);
  } catch (err) {
    console.warn(
      `[seed] could not push workspace template to MinIO (${
        err instanceof Error ? err.message : String(err)
      }). Row is in place; re-run seed once MinIO is up.`,
    );
  }
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
