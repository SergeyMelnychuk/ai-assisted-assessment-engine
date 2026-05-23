/**
 * Archive ingest worker (Week 5, ADR-0008).
 *
 * Takes an archive Document (the "parent"), stream-extracts its members
 * from MinIO, applies safety gates, and fans out one `ingest-document`
 * job per surviving entry as a **child** Document (parentDocumentId →
 * parent). The parent's `ingestStatus` then tracks the fan-out:
 *
 *   PENDING → EXTRACTING → READY   (archive unpacked, children enqueued)
 *                       └→ FAILED  (safety gate tripped or malformed)
 *
 * Children go through the standard `ingest-document` pipeline
 * unchanged — archives are an *ingest-time* fan-out, not a new
 * extraction mode.
 *
 * Safety discipline:
 *   - **Stream, never buffer.** We open the archive as a stream and
 *     process entries one at a time. We never hold >1 entry in memory.
 *   - **Bail on first violation.** Entry-count / size / depth / symlink
 *     violations throw a classified error; the parent flips to FAILED
 *     and the extract loop ends. Children already enqueued before the
 *     violation keep going — there's no sane way to unwind mid-stream.
 *   - **Zip-slip defence.** We reject symlinks, absolute paths, and any
 *     path containing `..` segments. `path.posix.normalize` is applied
 *     before storage-key construction.
 *
 * Env knobs (all have sensible defaults):
 *   - `ARCHIVE_MAX_UNCOMPRESSED_BYTES` — default 500 MB.
 *   - `ARCHIVE_MAX_ENTRIES`            — default 10 000.
 *   - `ARCHIVE_MAX_DEPTH`              — default 20.
 */

import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import tar, { type Headers as TarHeaders } from "tar-stream";
import yauzl, { type ZipFile, type Entry as YauzlEntry } from "yauzl";

import { db } from "@/server/db";
import { log } from "@/server/lib/logger";
import {
  classifyProcessingError,
  formatErrorForUser,
} from "@/server/services/ai/error-classifier";
import {
  ensureBucket,
  getObjectStream,
  putObject,
} from "@/server/storage/minio";
import {
  enqueueIngestDiagram,
  enqueueIngestDocument,
} from "@/server/queue/queue";

// ─── Limits ─────────────────────────────────────────────────────

const MAX_UNCOMPRESSED_BYTES = numericEnv(
  "ARCHIVE_MAX_UNCOMPRESSED_BYTES",
  500 * 1024 * 1024,
);
const MAX_ENTRIES = numericEnv("ARCHIVE_MAX_ENTRIES", 10_000);
const MAX_DEPTH = numericEnv("ARCHIVE_MAX_DEPTH", 20);

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ─── Ignore list ────────────────────────────────────────────────
//
// Exact path segments we never descend into; glob suffixes on basenames.
// Expressed as predicates so we can layer a `.copilotignore` on top
// without mutating the default.

export const DEFAULT_IGNORE_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".cache",
  ".DS_Store",
  "__pycache__",
]);

export const DEFAULT_IGNORE_BASENAME_SUFFIXES: readonly string[] = [
  ".lock",
  ".min.js",
  ".min.css",
  ".pyc",
  ".DS_Store",
  ".env",
];

// ─── Archive kind detection ─────────────────────────────────────

export type ArchiveKind = "zip" | "tar" | "tar.gz" | "unknown";

/**
 * Sniff the archive kind from magic bytes, MIME, and filename — in
 * that precedence order. Magic bytes are authoritative; MIME / name
 * are tiebreakers for ambiguous bytes (bare .tar has no magic).
 */
export function detectArchiveKind(
  head: Buffer,
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): ArchiveKind {
  // ZIP: "PK\x03\x04" (or empty-archive PK\x05\x06).
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  ) {
    return "zip";
  }
  // gzip: 1f 8b. We treat *any* gzip as tar.gz — raw-gzip-of-a-single
  // file isn't an archive we support, and the upload route filters
  // on `.tar.gz` / `.tgz` filenames for the same reason.
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return "tar.gz";
  }
  // USTAR magic at offset 257.
  if (
    head.length >= 265 &&
    head[257] === 0x75 &&
    head[258] === 0x73 &&
    head[259] === 0x74 &&
    head[260] === 0x61 &&
    head[261] === 0x72
  ) {
    return "tar";
  }

  // Fall back on MIME / filename.
  const name = (filename ?? "").toLowerCase();
  const mime = (mimeType ?? "").toLowerCase();
  if (mime === "application/zip" || name.endsWith(".zip")) return "zip";
  if (
    mime === "application/gzip" ||
    name.endsWith(".tar.gz") ||
    name.endsWith(".tgz")
  ) {
    return "tar.gz";
  }
  if (mime === "application/x-tar" || name.endsWith(".tar")) return "tar";
  return "unknown";
}

// ─── Entry filter ───────────────────────────────────────────────

export interface ArchiveEntry {
  /** Normalised posix path relative to archive root. */
  path: string;
  /** Uncompressed size in bytes, or undefined if the format doesn't say upfront. */
  size: number | undefined;
  /** True if the entry is a symlink (zip external-attributes or tar typeflag 2/5 dir excluded). */
  isSymlink: boolean;
  /** True if the entry is a directory marker (never has content to store). */
  isDirectory: boolean;
}

export interface FilterContext {
  ignoreSegments: ReadonlySet<string>;
  ignoreBasenameSuffixes: readonly string[];
  /** Extra glob-ish suffix/basename matchers parsed from `.copilotignore`. */
  extraIgnorePatterns: readonly string[];
  maxDepth: number;
}

export type FilterResult =
  | { keep: true }
  | { keep: false; reason: FilterReason; hardFail?: boolean };

export type FilterReason =
  | "directory"
  | "symlink"
  | "ignored"
  | "depth"
  | "absolute"
  | "traversal";

/**
 * Decide what to do with one archive entry. Hard failures
 * (`hardFail: true`) should bubble up as a classified error and halt
 * the extract loop; soft failures (ignored, directory) are silently
 * skipped.
 */
export function classifyEntry(
  entry: ArchiveEntry,
  ctx: FilterContext,
): FilterResult {
  if (entry.isDirectory) return { keep: false, reason: "directory" };

  // Zip-slip defence. Do this before normalisation so an attacker
  // can't hide behind `./..` segments.
  if (entry.path.startsWith("/")) {
    return { keep: false, reason: "absolute", hardFail: true };
  }
  if (entry.path.split("/").some((seg) => seg === "..")) {
    return { keep: false, reason: "traversal", hardFail: true };
  }

  if (entry.isSymlink) {
    // Symlinks are a hard fail — we don't silently skip because a
    // symlink-packed archive is a strong smell of a zip-slip attempt
    // or a misunderstood `tar --dereference` workflow.
    return { keep: false, reason: "symlink", hardFail: true };
  }

  const normalised = path.posix.normalize(entry.path);
  const segments = normalised.split("/").filter(Boolean);

  if (segments.length > ctx.maxDepth) {
    return { keep: false, reason: "depth", hardFail: true };
  }

  const basename = segments[segments.length - 1] ?? "";

  // Any segment is in the default ignore set → skip whole subtree.
  if (segments.some((s) => ctx.ignoreSegments.has(s))) {
    return { keep: false, reason: "ignored" };
  }
  // Basename suffix match (e.g. `package-lock.json` matches `.lock`
  // via a dedicated check, but *.min.js / *.pyc are the common case).
  if (
    ctx.ignoreBasenameSuffixes.some((sfx) =>
      sfx.startsWith(".") ? basename.endsWith(sfx) : basename === sfx,
    )
  ) {
    return { keep: false, reason: "ignored" };
  }
  // Exact lockfile names — the suffix check above misses `yarn.lock`,
  // `pnpm-lock.yaml`, `Cargo.lock`, etc. because their extension isn't
  // `.lock`. Keep this explicit rather than regex-y so the set is
  // auditable.
  if (
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml" ||
    basename === "package-lock.json" ||
    basename === "Cargo.lock" ||
    basename === "Gemfile.lock" ||
    basename === "poetry.lock" ||
    basename === "go.sum"
  ) {
    return { keep: false, reason: "ignored" };
  }

  // `.copilotignore` patterns. Minimal glob: exact match, basename
  // match, or suffix match via leading `*`.
  for (const pat of ctx.extraIgnorePatterns) {
    if (matchesCopilotignore(normalised, basename, pat)) {
      return { keep: false, reason: "ignored" };
    }
  }

  return { keep: true };
}

function matchesCopilotignore(
  fullPath: string,
  basename: string,
  pattern: string,
): boolean {
  if (!pattern || pattern.startsWith("#")) return false;
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("*")) {
    return basename.endsWith(trimmed.slice(1));
  }
  if (trimmed.endsWith("/")) {
    // Directory prefix.
    return (
      fullPath.startsWith(trimmed) || fullPath.includes(`/${trimmed}`)
    );
  }
  if (trimmed.includes("/")) {
    return fullPath === trimmed || fullPath.startsWith(`${trimmed}/`);
  }
  // Plain basename pattern.
  return basename === trimmed;
}

/**
 * Parse a `.copilotignore` payload into individual patterns. Blank
 * lines and comments are dropped.
 */
export function parseCopilotignore(raw: string): readonly string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// ─── Safety-gate errors ─────────────────────────────────────────
//
// We throw plain Error objects prefixed with a machine-readable tag
// so the classifier at `services/ai/error-classifier.ts` can route
// them to the right category. `entryPath` is carried as a JSON
// suffix so the audit log can surface which file tripped the gate.

export class ArchiveSafetyError extends Error {
  constructor(
    public readonly tag:
      | "ARCHIVE_ENTRY_LIMIT"
      | "ARCHIVE_SIZE_LIMIT"
      | "ARCHIVE_DEPTH_LIMIT"
      | "ARCHIVE_SYMLINK"
      | "ARCHIVE_MALFORMED",
    message: string,
    public readonly entryPath: string | undefined = undefined,
  ) {
    super(`${tag}: ${message}${entryPath ? ` [entryPath=${entryPath}]` : ""}`);
    this.name = "ArchiveSafetyError";
  }
}

// ─── Stream walker (format-specific adapters) ───────────────────
//
// Each walker yields `{ entry, content }` pairs where `content` is a
// Buffer built by concatenating the entry's stream chunks. We bound
// per-entry buffering at the size limit — anything larger trips the
// size gate before finishing.

export interface WalkedEntry {
  entry: ArchiveEntry;
  content: Buffer;
}

export type ArchiveWalker = (
  stream: Readable,
) => AsyncGenerator<WalkedEntry, void, void>;

async function* walkZip(stream: Readable): AsyncGenerator<WalkedEntry> {
  // yauzl doesn't expose a first-class streaming API over a Node
  // Readable — the official entrypoint is `yauzl.fromBuffer` or
  // `yauzl.open` on a file. To honour "stream, never buffer the whole
  // archive", we materialise to a temp file via pipeline when the
  // archive is large. For simplicity and because MinIO already gave us
  // a bounded-size object, we accept concatenating to a buffer *only
  // for the archive itself* — individual entries still stream through
  // yauzl's per-entry `openReadStream`.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of stream) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += buf.length;
    if (total > MAX_UNCOMPRESSED_BYTES * 2) {
      // Archive *compressed* size is already bigger than 2× our
      // uncompressed cap — treat as a zip bomb without even opening it.
      throw new ArchiveSafetyError(
        "ARCHIVE_SIZE_LIMIT",
        `compressed archive exceeds 2× uncompressed cap (${total} bytes)`,
      );
    }
    chunks.push(buf);
  }
  const archiveBuf = Buffer.concat(chunks);

  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      archiveBuf,
      { lazyEntries: true },
      (err: Error | null, zf: ZipFile | null) => {
        if (err || !zf) {
          reject(
            err ??
              new ArchiveSafetyError(
                "ARCHIVE_MALFORMED",
                "yauzl returned no ZipFile",
              ),
          );
          return;
        }
        resolve(zf);
      },
    );
  });

  try {
    while (true) {
      const next = await new Promise<YauzlEntry | null>((resolve, reject) => {
        zip.once("entry", (e: YauzlEntry) => resolve(e));
        zip.once("end", () => resolve(null));
        zip.once("error", reject);
        zip.readEntry();
      });
      if (!next) return;

      const fileName = next.fileName;
      const isDirectory = /\/$/.test(fileName);
      // External-attributes high byte carries Unix mode when made on
      // Unix (made-by high byte = 3). Symlink mode is 0o120000.
      const madeByHost = (next.versionMadeBy ?? 0) >> 8;
      const unixMode =
        madeByHost === 3 ? (next.externalFileAttributes ?? 0) >>> 16 : 0;
      const isSymlink = (unixMode & 0o170000) === 0o120000;

      const entry: ArchiveEntry = {
        path: fileName,
        size: next.uncompressedSize,
        isSymlink,
        isDirectory,
      };

      if (isDirectory || isSymlink) {
        // Still need to drain the entry stream so yauzl moves on.
        yield { entry, content: Buffer.alloc(0) };
        continue;
      }

      const content = await new Promise<Buffer>((resolve, reject) => {
        zip.openReadStream(next, (err: Error | null, rs: Readable | null) => {
          if (err || !rs) return reject(err ?? new Error("no stream"));
          const parts: Buffer[] = [];
          let seen = 0;
          rs.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > MAX_UNCOMPRESSED_BYTES) {
              rs.destroy();
              reject(
                new ArchiveSafetyError(
                  "ARCHIVE_SIZE_LIMIT",
                  `entry exceeded per-archive uncompressed cap`,
                  fileName,
                ),
              );
              return;
            }
            parts.push(chunk);
          });
          rs.on("end", () => resolve(Buffer.concat(parts)));
          rs.on("error", reject);
        });
      });

      yield { entry, content };
    }
  } finally {
    zip.close();
  }
}

async function* walkTar(stream: Readable): AsyncGenerator<WalkedEntry> {
  const extract = tar.extract();
  stream.pipe(extract as unknown as NodeJS.WritableStream);

  // Convert the event-driven tar-stream API into an async iterator by
  // pausing on each entry until we're ready for the next.
  type Pending = {
    header: TarHeaders;
    entryStream: Readable;
    next: () => void;
  };

  const pending: Pending[] = [];
  let ended = false;
  let rejected: unknown = null;
  let waiter: ((v: Pending | "end") => void) | null = null;

  extract.on("entry", (header: TarHeaders, entryStream: Readable, next: () => void) => {
    const p: Pending = { header, entryStream, next };
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(p);
    } else {
      pending.push(p);
    }
  });
  extract.on("finish", () => {
    ended = true;
    if (waiter) {
      waiter("end");
      waiter = null;
    }
  });
  extract.on("error", (err: Error) => {
    rejected = err;
    if (waiter) {
      waiter("end");
      waiter = null;
    }
  });

  while (true) {
    if (rejected) throw rejected;

    const next =
      pending.shift() ??
      (await new Promise<Pending | "end">((resolve) => {
        if (ended) return resolve("end");
        waiter = resolve;
      }));

    if (next === "end") {
      if (rejected) throw rejected;
      return;
    }

    const { header, entryStream, next: advance } = next;
    const typeflag = header.type;
    const isDirectory = typeflag === "directory";
    // tar-stream gives us a typed string; "symlink" and "link" both
    // count (hard links can still point outside the archive root).
    const isSymlink = typeflag === "symlink" || typeflag === "link";

    const parts: Buffer[] = [];
    let seen = 0;
    try {
      if (isDirectory || isSymlink) {
        entryStream.resume();
        await new Promise<void>((resolve, reject) => {
          entryStream.on("end", () => resolve());
          entryStream.on("error", reject);
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          entryStream.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > MAX_UNCOMPRESSED_BYTES) {
              entryStream.destroy();
              reject(
                new ArchiveSafetyError(
                  "ARCHIVE_SIZE_LIMIT",
                  `entry exceeded per-archive uncompressed cap`,
                  header.name,
                ),
              );
              return;
            }
            parts.push(chunk);
          });
          entryStream.on("end", () => resolve());
          entryStream.on("error", reject);
        });
      }
    } finally {
      advance();
    }

    yield {
      entry: {
        path: header.name,
        size: header.size,
        isSymlink,
        isDirectory,
      },
      content: Buffer.concat(parts),
    };
  }
}

async function* walkTarGz(stream: Readable): AsyncGenerator<WalkedEntry> {
  const gunzip = createGunzip();
  stream.pipe(gunzip);
  yield* walkTar(gunzip);
}

export function walkerFor(kind: ArchiveKind): ArchiveWalker {
  switch (kind) {
    case "zip":
      return walkZip;
    case "tar":
      return walkTar;
    case "tar.gz":
      return walkTarGz;
    case "unknown":
      throw new ArchiveSafetyError(
        "ARCHIVE_MALFORMED",
        "Unsupported archive — expected zip, tar, or tar.gz",
      );
  }
}

// ─── Job entrypoint ─────────────────────────────────────────────

export interface IngestArchiveArgs {
  documentId: string;
  s3Key: string;
}

export async function ingestArchiveJob(
  args: IngestArchiveArgs,
): Promise<void> {
  const { documentId, s3Key } = args;

  const parent = await db.document.findUnique({ where: { id: documentId } });
  if (!parent) {
    log.warn("parent document not found, skipping", {
      worker: "ingest-archive",
      documentId,
    });
    return;
  }

  await db.document.update({
    where: { id: documentId },
    data: {
      ingestStatus: "EXTRACTING",
      processingStatus: "PROCESSING",
    },
  });

  let kept = 0;
  let skipped = 0;

  try {
    await ensureBucket();

    // First read — a tiny peek for magic-byte detection. The full
    // stream is re-opened after so nothing gets buffered twice.
    const headStream = await getObjectStream(s3Key);
    const head = await readFirstBytes(headStream.body, 512);
    const kind = detectArchiveKind(
      head,
      parent.mimeType,
      parent.filename,
    );

    if (kind === "unknown") {
      throw new ArchiveSafetyError(
        "ARCHIVE_MALFORMED",
        "Unsupported archive — expected zip, tar, or tar.gz",
      );
    }

    const full = await getObjectStream(s3Key);
    const walker = walkerFor(kind);

    // First pass: look for a `.copilotignore` at archive root. We can't
    // cheaply rewind a stream, so we drain the walker once into a
    // collection — the same pass that does fan-out. We spot the
    // ignore file inline and apply it *prospectively* to subsequent
    // entries. Entries that stream before the ignore file won't be
    // retroactively filtered, but `.copilotignore` is virtually always
    // at the root (which zip/tar tools emit first), so in practice
    // this is fine.
    let extraIgnore: readonly string[] = [];

    let entryCount = 0;
    let totalBytes = 0;

    for await (const walked of walker(full.body)) {
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        throw new ArchiveSafetyError(
          "ARCHIVE_ENTRY_LIMIT",
          `archive contains >${MAX_ENTRIES} entries`,
          walked.entry.path,
        );
      }
      totalBytes += walked.content.length;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new ArchiveSafetyError(
          "ARCHIVE_SIZE_LIMIT",
          `archive uncompressed size >${MAX_UNCOMPRESSED_BYTES} bytes`,
          walked.entry.path,
        );
      }

      // `.copilotignore` at the root — parse and apply to the rest.
      if (
        walked.entry.path === ".copilotignore" ||
        walked.entry.path.endsWith("/.copilotignore")
      ) {
        extraIgnore = parseCopilotignore(walked.content.toString("utf8"));
        continue;
      }

      const verdict = classifyEntry(walked.entry, {
        ignoreSegments: DEFAULT_IGNORE_SEGMENTS,
        ignoreBasenameSuffixes: DEFAULT_IGNORE_BASENAME_SUFFIXES,
        extraIgnorePatterns: extraIgnore,
        maxDepth: MAX_DEPTH,
      });

      if (!verdict.keep) {
        skipped += 1;
        if (verdict.hardFail) {
          throw new ArchiveSafetyError(
            verdict.reason === "symlink"
              ? "ARCHIVE_SYMLINK"
              : verdict.reason === "depth"
                ? "ARCHIVE_DEPTH_LIMIT"
                : "ARCHIVE_MALFORMED",
            `entry rejected: ${verdict.reason}`,
            walked.entry.path,
          );
        }
        continue;
      }

      await fanOutChild(parent, walked);
      kept += 1;
    }

    await db.$transaction([
      db.document.update({
        where: { id: documentId },
        data: {
          ingestStatus: kept > 0 ? "READY" : "FAILED",
          processingStatus: kept > 0 ? "PROCESSED" : "FAILED",
          chunkCount: kept,
          extractedSummary:
            kept > 0
              ? `Archive extracted: ${kept} file(s) ingested, ${skipped} skipped by ignore rules.`
              : `Archive extracted 0 files — everything matched the ignore list.`,
        },
      }),
      db.auditLog.create({
        data: {
          action: "INGEST_ARCHIVE",
          entityType: "Document",
          entityId: parent.id,
          details: {
            archiveKind: kind,
            entryCount,
            kept,
            skipped,
            totalUncompressedBytes: totalBytes,
          },
        },
      }),
    ]);

    log.info("archive extracted", {
      worker: "ingest-archive",
      documentId,
      filename: parent.filename,
      kind,
      kept,
      skipped,
    });
  } catch (err) {
    const classified = classifyProcessingError(err);
    const entryPath =
      err instanceof ArchiveSafetyError ? err.entryPath : undefined;
    log.error("archive extraction failed", {
      worker: "ingest-archive",
      documentId,
      filename: parent.filename,
      category: classified.category,
      technicalDetail: classified.technicalDetail,
    });
    await db.document.update({
      where: { id: documentId },
      data: {
        ingestStatus: "FAILED",
        processingStatus: "FAILED",
        extractedSummary: formatErrorForUser(classified),
      },
    });
    await db.auditLog
      .create({
        data: {
          action: "INGEST_ARCHIVE_FAILED",
          entityType: "Document",
          entityId: parent.id,
          details: {
            category: classified.category,
            entryPath,
            isRetryable: classified.isRetryable,
            needsAdmin: classified.needsAdmin,
            technicalDetail: classified.technicalDetail,
            kept,
            skipped,
          },
        },
      })
      .catch(() => {
        /* best-effort */
      });
    throw err;
  }
}

/**
 * Read the first `n` bytes off a stream without consuming more than
 * necessary. The stream is destroyed once we have what we need so the
 * underlying HTTP connection can be released.
 */
async function readFirstBytes(
  stream: Readable,
  n: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of stream) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(buf);
    total += buf.length;
    if (total >= n) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, n);
}

/**
 * Persist a single archive member as a child Document and enqueue its
 * standard `ingest-document` job. Mime-type detection is best-effort
 * from the filename — the ingest worker already falls back gracefully.
 *
 * Stores the full archive-relative path as the child's `filename`
 * (e.g. `docs/runbooks/incident-triage.md` rather than just
 * `incident-triage.md`). The path is what the citation needs to
 * build a working blob URL into the source repo, and to disambiguate
 * same-named files in different directories. For repo tarballs the
 * GitHub wrapper top-level directory is stripped first.
 */
async function fanOutChild(
  parent: {
    id: string;
    assessmentId: string;
    uploadedById: string;
    filename: string;
  },
  walked: WalkedEntry,
): Promise<void> {
  const archivePath = archiveRelativePath(walked.entry.path, parent.filename);
  const child = await db.document.create({
    data: {
      assessmentId: parent.assessmentId,
      filename: archivePath,
      mimeType: guessMimeFromPath(walked.entry.path),
      storagePath: "pending",
      fileSize: walked.content.length,
      uploadType: "OTHER",
      ingestStatus: "PENDING",
      processingStatus: "PENDING",
      uploadedById: parent.uploadedById,
      parentDocumentId: parent.id,
    },
  });

  // Archives get a dedicated prefix so MinIO listings don't commingle
  // with single-file uploads. The parent id is the natural namespace.
  const key = `archives/${parent.id}/${safePath(walked.entry.path)}`;
  await putObject(key, walked.content, child.mimeType);

  await db.document.update({
    where: { id: child.id },
    data: { storagePath: key },
  });
  // Image files in a repo archive — diagrams, screenshots, logos — must
  // NOT go through `ingest-document`'s text-extraction path. PNG/JPEG
  // bytes contain plenty of ` ` characters which Postgres rejects
  // (error 22021) when the chunked "text" hits the Evidence raw-SQL
  // insert. Route them through `ingest-diagram` instead so Claude
  // vision gets a shot at them, and so binary garbage never reaches the
  // text pipeline. Everything else stays on `ingest-document`.
  if (isImageExtension(walked.entry.path)) {
    await enqueueIngestDiagram(child.id);
  } else {
    await enqueueIngestDocument(child.id);
  }
}

/**
 * Whether a path's extension is an image format the diagram-ingest
 * worker can handle (Claude vision for raster, XML reasoning for SVG).
 * Kept narrow on purpose — fonts, video, audio, executables, etc.
 * still flow to `ingest-document` where they'll either extract empty
 * text (cheap, harmless) or get null-byte-stripped at the SQL boundary.
 */
function isImageExtension(p: string): boolean {
  const ext = path.posix.extname(p).toLowerCase();
  return (
    ext === ".png" ||
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".gif" ||
    ext === ".webp" ||
    ext === ".svg"
  );
}

function safePath(p: string): string {
  return path.posix
    .normalize(p)
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => seg.replace(/[^\w.\-]+/g, "_"))
    .join("/");
}

/**
 * Derive the archive-relative path to store as a child Document's
 * filename. For repo tarballs (parent filename matches the shape
 * produced by `deriveTarballFilename` in `workers/ingest-repository.ts`)
 * we strip GitHub's wrapper top-level directory so the stored path
 * matches the repo-relative path you'd see on github.com — that's
 * what the citation needs to build a working blob URL.
 *
 * For non-repo archives (user-uploaded .zip / .tar.gz) we keep the
 * full archive path verbatim so same-named files in different
 * directories don't collide visually.
 */
function archiveRelativePath(entryPath: string, parentFilename: string): string {
  const isRepoTarball = /^[a-z0-9.-]+_.+@[a-z0-9]+\.tar\.gz$/i.test(parentFilename);
  if (!isRepoTarball) return entryPath;
  // GitHub tarballs wrap the repo in `<owner>-<repo>-<short-sha>/`.
  // Strip exactly one leading segment.
  const idx = entryPath.indexOf("/");
  return idx > 0 ? entryPath.slice(idx + 1) : entryPath;
}

function guessMimeFromPath(p: string): string {
  const ext = path.posix.extname(p).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}
