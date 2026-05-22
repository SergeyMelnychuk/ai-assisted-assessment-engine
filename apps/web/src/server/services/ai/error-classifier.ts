/**
 * Translates raw errors from the AI pipeline into something a consultant
 * can act on. Every job handler (`ingest-document`, `ingest-diagram`,
 * `run-analysis`, `run-estimation`, `generate-deliverable`) funnels its
 * caught exception through `classifyProcessingError()` before writing
 * anything user-visible.
 *
 * The raw technical detail is still preserved — it lands in the
 * audit-log row so engineers can debug — but the surface the consultant
 * sees (the `extractedSummary` on a Document, the failure banner on an
 * Assessment, etc.) carries `userMessage` only.
 */

export type ErrorCategory =
  | "AI_BILLING"
  | "AI_MODEL"
  | "AI_AUTH"
  | "AI_OVERLOADED"
  | "AI_RATE_LIMITED"
  | "AI_OUTPUT_TOO_LARGE"
  | "AI_MALFORMED"
  | "AI_EMPTY"
  // Per-call timeout (see `CLAUDE_CALL_TIMEOUT_MS` in claude-client).
  // Distinct from AI_OVERLOADED so dashboards can tell "SDK hung with
  // no response" from "529 fast-fail" — the fixes are different
  // (network / proxy vs. backend capacity).
  | "AI_TIMEOUT"
  | "NO_TEXT"
  // Week 1 (ADR-0001): ingest-only failures, distinct from AI_* so the
  // UI can surface them with ingest-appropriate copy ("text extraction
  // failed" is different from "AI call failed").
  | "INGEST_EXTRACTION_FAILED"
  | "INGEST_CHUNK_FAILED"
  // Week 2 (ADR-0002): some domains succeeded, some failed during a
  // per-domain analysis fan-out. Surfaced when a subsequent run triggers
  // classifier paths, or synthesised directly by the UI from the
  // audit-log `details.domains` map.
  | "ANALYSIS_PARTIAL_FAILURE"
  // Week 3 (ADR-0003): embedding service failures, distinct from
  // AI_* so the UI can tell consultants "the embedding provider is
  // unreachable" without implying the Claude analysis went wrong.
  | "EMBEDDING_AUTH_FAILED"
  | "EMBEDDING_RATE_LIMITED"
  | "EMBEDDING_REQUEST_FAILED"
  // Week 5 (ADR-0008): archive-ingest safety-gate violations. These
  // all terminate the extract loop on first hit — the surviving
  // children already-enqueued keep going, but no further entries
  // from the offending archive are processed.
  | "ARCHIVE_ENTRY_LIMIT"
  | "ARCHIVE_SIZE_LIMIT"
  | "ARCHIVE_DEPTH_LIMIT"
  | "ARCHIVE_SYMLINK"
  | "ARCHIVE_MALFORMED"
  // Week 6 (ADR-0009/0010): repository-linking failures. Distinct
  // from ARCHIVE_* because the recovery path is different — an auth
  // failure is a PAT rotation, not a repack of the archive.
  | "REPO_AUTH_FAILED"
  | "REPO_NOT_FOUND"
  | "REPO_RATE_LIMITED"
  | "REPO_TARBALL_TOO_LARGE"
  | "STORAGE"
  | "DB"
  | "UNKNOWN";

export interface ClassifiedError {
  /** Short, scannable label — e.g. "Out of AI credits". Shown as a badge. */
  label: string;
  /** Plain-language description of what went wrong. Shown as body text. */
  userMessage: string;
  /** What the user (or admin) can do about it. Usually 1–2 sentences. */
  nextStep: string;
  /** Full raw error message. Goes to AuditLog.details and server stdout. */
  technicalDetail: string;
  /** Coarse category so the UI can pick an icon/tone without parsing strings. */
  category: ErrorCategory;
  /** True if clicking Retry might succeed without admin intervention. */
  isRetryable: boolean;
  /** True if an admin needs to fix config/billing before retry can help. */
  needsAdmin: boolean;
}

/**
 * Regex-based classification. Ordered by specificity: the most precise
 * signature wins. If nothing matches we fall through to `UNKNOWN` with
 * a "something went wrong, try again or contact your admin" message.
 */
export function classifyProcessingError(err: unknown): ClassifiedError {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";

  // ─── Per-call timeout (claude-client `withClaudeTimeout`) ─────
  //
  // Matched first so a stray "aborted" / "AbortError" substring
  // elsewhere can't drift into an unrelated bucket. We gate on the
  // dedicated class name plus the tagged message so we don't mis-
  // classify a genuine user-cancel (`CancelledError`) as a provider
  // timeout — CancelledError is intercepted before we get here.
  if (
    name === "ClaudeCallTimeoutError" ||
    /CLAUDE_TIMEOUT/.test(raw) ||
    (name === "AbortError" && !/cancelled/i.test(raw))
  ) {
    return {
      label: "AI call timed out",
      userMessage:
        "The AI call didn't return within our per-call time budget. This usually means the provider is slow or a network hop stalled — nothing was saved.",
      nextStep:
        "Click Retry. If it keeps timing out, an administrator can check provider status or raise `CLAUDE_CALL_TIMEOUT_MS`.",
      technicalDetail: raw,
      category: "AI_TIMEOUT",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  // ─── Anthropic / AI provider errors ────────────────────────────

  if (/credit balance is too low/i.test(raw)) {
    return {
      label: "Out of AI credits",
      userMessage:
        "The AI service can't process this right now — the connected Anthropic account has no credits remaining.",
      nextStep:
        "Ask your administrator to top up the Anthropic account. Once funded, click Retry — no need to re-upload.",
      technicalDetail: raw,
      category: "AI_BILLING",
      isRetryable: true,
      needsAdmin: true,
    };
  }

  if (/not_found_error.*model|model.*not_found/i.test(raw)) {
    return {
      label: "AI model unavailable",
      userMessage:
        "The AI model this server is configured to use isn't available on the connected account.",
      nextStep:
        "An administrator needs to update the `ANTHROPIC_MODEL` setting to a model your account has access to.",
      technicalDetail: raw,
      category: "AI_MODEL",
      isRetryable: false,
      needsAdmin: true,
    };
  }

  // Embedding-provider signals must be matched BEFORE the generic
  // AI_AUTH / AI_RATE_LIMITED blocks — a bare "401" string on an
  // OpenAI error would otherwise get mis-classified as a Claude
  // auth failure and point the admin at the wrong env var.
  if (/openai.*auth|OpenAI.*401|Incorrect API key provided/i.test(raw)) {
    return {
      label: "Embedding provider not authenticated",
      userMessage:
        "The embedding service (OpenAI) isn't accepting our API key.",
      nextStep:
        "Ask an administrator to check the `OPENAI_API_KEY` configuration, or switch `EMBEDDING_MODE=fake` for tests.",
      technicalDetail: raw,
      category: "EMBEDDING_AUTH_FAILED",
      isRetryable: false,
      needsAdmin: true,
    };
  }
  if (/openai.*rate.?limit|openai.*429/i.test(raw)) {
    return {
      label: "Embedding provider rate-limited",
      userMessage:
        "We're sending embedding requests faster than the provider accepts right now.",
      nextStep:
        "Wait a minute, then click Retry. The backfill script retries rate-limit errors once per batch automatically; live ingest does not.",
      technicalDetail: raw,
      category: "EMBEDDING_RATE_LIMITED",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  if (/authentication_error|invalid[\s_-]?api[\s_-]?key|401/i.test(raw)) {
    return {
      label: "AI service not authenticated",
      userMessage:
        "The AI service isn't accepting our API key. Nothing you can fix directly.",
      nextStep:
        "Ask an administrator to check the `ANTHROPIC_API_KEY` configuration.",
      technicalDetail: raw,
      category: "AI_AUTH",
      isRetryable: false,
      needsAdmin: true,
    };
  }

  if (/rate[\s_-]?limit|429/i.test(raw)) {
    return {
      label: "AI service rate-limited",
      userMessage:
        "We're sending requests faster than the AI service accepts right now.",
      nextStep:
        "Wait a minute, then click Retry. Each retry re-bills tokens, so the app won't retry automatically.",
      technicalDetail: raw,
      category: "AI_RATE_LIMITED",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  if (/\b529\b|overloaded_error|overloaded/i.test(raw)) {
    return {
      label: "AI service overloaded",
      userMessage:
        "The AI service is temporarily overloaded on their end — common during peak hours.",
      nextStep:
        "Wait a moment and click Retry. Each retry re-bills tokens, so the app won't retry automatically.",
      technicalDetail: raw,
      category: "AI_OVERLOADED",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  // ─── Output-shape problems (parser) ────────────────────────────

  if (
    /response appears truncated|(Failed to parse JSON).*truncat/i.test(raw)
  ) {
    return {
      label: "Document too rich for one analysis pass",
      userMessage:
        "The AI started analysing this document but hit our per-run size budget before finishing. Nothing was saved.",
      nextStep:
        "Try a shorter or more focused version of the document, or split it into sections and upload them separately. Alternatively an administrator can raise the output budget for document analysis.",
      technicalDetail: raw,
      category: "AI_OUTPUT_TOO_LARGE",
      isRetryable: true, // with a different / smaller doc
      needsAdmin: false,
    };
  }

  if (/Failed to parse JSON/i.test(raw)) {
    return {
      label: "AI returned an unexpected response",
      userMessage:
        "The AI's reply didn't match the format we expect. This can happen occasionally with non-deterministic models.",
      nextStep:
        "Click Retry. If it fails again, the document may need manual summarisation — copy the key points into the project-context form instead.",
      technicalDetail: raw,
      category: "AI_MALFORMED",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  if (/No text response from Claude/i.test(raw)) {
    return {
      label: "Empty AI response",
      userMessage:
        "The AI finished the call but returned no content.",
      nextStep:
        "Click Retry. If it keeps returning empty, contact your administrator.",
      technicalDetail: raw,
      category: "AI_EMPTY",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  // ─── Embedding-service generic failure fall-through ───────────
  // (The specific 401/429 signatures are matched earlier, before the
  // generic AI_AUTH / AI_RATE_LIMITED blocks, so they can't collide.)

  if (/embedding.*(failed|error)|openai.*embedding/i.test(raw)) {
    return {
      label: "Embedding request failed",
      userMessage:
        "The embedding provider couldn't process one or more chunks.",
      nextStep:
        "Click Retry. If it keeps failing, an administrator can check the worker logs or swap models via `EMBEDDING_MODEL`.",
      technicalDetail: raw,
      category: "EMBEDDING_REQUEST_FAILED",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  // ─── Ingest-only failures (Week 1, ADR-0001) ──────────────────
  //
  // Ordered *before* the generic NO_TEXT/storage patterns so the more
  // specific signatures win. These surface on the Documents tab as
  // ingest-progress failures, distinct from AI_* analysis failures.

  if (/chunkDocumentText|after chunking/i.test(raw)) {
    return {
      label: "Couldn't chunk this document",
      userMessage:
        "We extracted text from this file but couldn't split it into usable chunks.",
      nextStep:
        "Try re-uploading the file in a different format (DOCX, plain text, or Markdown). If the problem persists, contact your administrator.",
      technicalDetail: raw,
      category: "INGEST_CHUNK_FAILED",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  if (
    /pdf-parse|PDFJS|InvalidPDFException|mammoth|ENOENT.*\.(pdf|docx)/i.test(
      raw,
    )
  ) {
    return {
      label: "Couldn't extract text from this file",
      userMessage:
        "Text extraction failed on this document. The file may be corrupt, password-protected, or in a format we don't fully support.",
      nextStep:
        "Re-export the source in PDF (with selectable text), DOCX, Markdown, or plain text, then upload again.",
      technicalDetail: raw,
      category: "INGEST_EXTRACTION_FAILED",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  // ─── Archive ingest safety gates (Week 5, ADR-0008) ───────────
  //
  // Ordered before the generic extraction / storage patterns so the
  // archive-specific signatures win. Each message is emitted by
  // `ingest-archive` with an `entryPath` in the details payload; the
  // matchers here only look at the raw message prefix.

  if (/ARCHIVE_ENTRY_LIMIT/.test(raw)) {
    return {
      label: "Archive has too many files",
      userMessage:
        "This archive exceeds the per-archive entry limit, so we stopped extracting before finishing.",
      nextStep:
        "Split the archive into smaller chunks (target < 10,000 entries per upload), or ask an administrator to raise `ARCHIVE_MAX_ENTRIES`.",
      technicalDetail: raw,
      category: "ARCHIVE_ENTRY_LIMIT",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  if (/ARCHIVE_SIZE_LIMIT/.test(raw)) {
    return {
      label: "Archive contents too large",
      userMessage:
        "The uncompressed contents of this archive exceed our per-archive size cap. This is our zip-bomb defence.",
      nextStep:
        "Prune non-essential folders (build output, vendor, caches) and re-archive, or ask an administrator to raise `ARCHIVE_MAX_UNCOMPRESSED_BYTES`.",
      technicalDetail: raw,
      category: "ARCHIVE_SIZE_LIMIT",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  if (/ARCHIVE_DEPTH_LIMIT/.test(raw)) {
    return {
      label: "Archive paths too deeply nested",
      userMessage:
        "One or more files in this archive sit below our maximum path depth. Usually a sign of an unintentional nested-archive tree.",
      nextStep:
        "Flatten the deepest directories and re-archive. If the depth is legitimate, ask an administrator to raise `ARCHIVE_MAX_DEPTH`.",
      technicalDetail: raw,
      category: "ARCHIVE_DEPTH_LIMIT",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  if (/ARCHIVE_SYMLINK/.test(raw)) {
    return {
      label: "Archive contains symlinks",
      userMessage:
        "This archive includes symbolic links, which we refuse to extract as a zip-slip / path-traversal defence.",
      nextStep:
        "Re-archive with symlinks dereferenced (e.g. `zip -y` off, `tar --dereference`) so each target is a regular file.",
      technicalDetail: raw,
      category: "ARCHIVE_SYMLINK",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  if (/ARCHIVE_MALFORMED|Unsupported archive|invalid signature/i.test(raw)) {
    return {
      label: "Archive couldn't be read",
      userMessage:
        "We couldn't parse this archive. It may be corrupt, truncated, or in a format we don't support (we accept zip, tar, and tar.gz).",
      nextStep:
        "Re-export the archive from the source tool and try again. If you meant to upload an individual file, use the normal upload button.",
      technicalDetail: raw,
      category: "ARCHIVE_MALFORMED",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  // ─── Repository linking (Week 6, ADR-0009/0010) ───────────────
  //
  // Ordered before the generic storage / DB fallbacks so the repo-
  // specific signatures win. Messages are emitted by
  // `github-provider.ts` with the tag prefix at the front.

  if (/REPO_AUTH_FAILED/.test(raw)) {
    return {
      label: "Repository authentication failed",
      userMessage:
        "GitHub rejected the personal access token. It may be expired, revoked, or missing the scope required to clone the repository.",
      nextStep:
        "Re-create the link with a fresh PAT that has `repo` (classic) or `Contents: Read` (fine-grained) scope. The old token is stored encrypted and can be safely deleted along with the link.",
      technicalDetail: raw,
      category: "REPO_AUTH_FAILED",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  if (/REPO_NOT_FOUND/.test(raw)) {
    return {
      label: "Repository not found",
      userMessage:
        "GitHub couldn't find the repository at that URL. Either the URL is wrong or the PAT lacks access to a private repo.",
      nextStep:
        "Double-check the `owner/repo` URL. If the repo is private, confirm the PAT's account has access and that the token's scope covers it.",
      technicalDetail: raw,
      category: "REPO_NOT_FOUND",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  if (/REPO_RATE_LIMITED/.test(raw)) {
    return {
      label: "GitHub rate-limited",
      userMessage:
        "GitHub's API rate limit for this token is exhausted. We honoured their Retry-After once but didn't loop — each retry is deliberate.",
      nextStep:
        "Wait for the window to reset (usually < 1 hour) and click Re-sync. Using a token attached to a user with a higher rate-limit tier avoids this.",
      technicalDetail: raw,
      category: "REPO_RATE_LIMITED",
      isRetryable: true,
      needsAdmin: false,
    };
  }

  if (/REPO_TARBALL_TOO_LARGE/.test(raw)) {
    return {
      label: "Repository too large for tarball ingest",
      userMessage:
        "This repository's tarball exceeds GitHub's 100 MB ceiling for the tarball API, so we couldn't download it in one call.",
      nextStep:
        "Link a subset instead — for MVP we don't stitch partial clones. Alternatively, archive the repo at a pruned ref (no large binaries) and link that.",
      technicalDetail: raw,
      category: "REPO_TARBALL_TOO_LARGE",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  // ─── Document / input problems ─────────────────────────────────

  if (/Extracted text is empty|unsupported format/i.test(raw)) {
    return {
      label: "Couldn't read this file",
      userMessage:
        "We couldn't extract any text from this file. It might be a scanned PDF without an OCR text layer, an image-only export, or an unsupported format.",
      nextStep:
        "Re-export the source in PDF (with selectable text), DOCX, Markdown, or plain text. We don't support OCR in this version.",
      technicalDetail: raw,
      category: "NO_TEXT",
      isRetryable: false,
      needsAdmin: false,
    };
  }

  // ─── Storage ──────────────────────────────────────────────────

  if (/S3|MinIO|ECONNREFUSED|NoSuchBucket|HeadBucket/i.test(raw)) {
    return {
      label: "Storage service unavailable",
      userMessage:
        "Our file-storage service is unreachable right now, so we can't load this file to process it.",
      nextStep:
        "Try again in a moment. If the problem persists, an administrator should check that MinIO / S3 is running.",
      technicalDetail: raw,
      category: "STORAGE",
      isRetryable: true,
      needsAdmin: true,
    };
  }

  if (/P2\d{3}|prisma|PrismaClient/i.test(raw)) {
    return {
      label: "Database error",
      userMessage:
        "We hit a database error while saving the analysis.",
      nextStep:
        "Click Retry. If it keeps failing, an administrator should check the Postgres logs.",
      technicalDetail: raw,
      category: "DB",
      isRetryable: true,
      needsAdmin: true,
    };
  }

  // ─── Fallback ─────────────────────────────────────────────────

  return {
    label: "Unexpected error",
    userMessage:
      "Something went wrong while processing this. We've captured the technical detail for diagnostics.",
    nextStep:
      "Click Retry. If it keeps failing, an administrator can inspect the worker logs.",
    technicalDetail: raw,
    category: "UNKNOWN",
    isRetryable: true,
    needsAdmin: false,
  };
}

/**
 * Render a classified error for the `extractedSummary` / user-visible
 * summary column. Keeps UI styling decisions here so the service layer
 * doesn't sprinkle markdown everywhere.
 */
export function formatErrorForUser(c: ClassifiedError): string {
  return `${c.userMessage}\n\n${c.nextStep}`;
}

/**
 * Router-visible failover classes (ADR-0015 §4). The router decides
 * whether to hop to the next binding based on these, not on the full
 * `ErrorCategory` union — most categories (AI_BILLING, AI_AUTH,
 * AI_OUTPUT_TOO_LARGE, AI_MALFORMED, …) are deterministic and would
 * fail the same way on the fallback provider, just more expensively.
 *
 * Kept in-sync with `FailoverClass` in `./model-registry.ts`; exported
 * here so the router's error path is a one-line map.
 */
export type RouterFailoverClass =
  | "rate_limit"
  | "overloaded"
  | "provider_5xx"
  | "timeout"
  | "connectivity";

/**
 * Map a classified AI error to a router failover class. Returns `null`
 * for deterministic failures the router should surface immediately
 * without retrying on a different provider.
 *
 * `provider_5xx` has no dedicated classifier category yet — we detect
 * it at the router boundary from the raw error (HTTP status, specific
 * message patterns not caught above). This helper therefore takes the
 * raw error as an optional second arg to check for 5xx shapes that
 * haven't been classified into a bucket.
 */
export function failoverClassFor(
  c: ClassifiedError,
  err?: unknown,
): RouterFailoverClass | null {
  switch (c.category) {
    case "AI_RATE_LIMITED":
    case "EMBEDDING_RATE_LIMITED":
    case "REPO_RATE_LIMITED":
      return "rate_limit";
    case "AI_OVERLOADED":
      return "overloaded";
    case "AI_TIMEOUT":
      return "timeout";
    default:
      break;
  }
  // Fall-through: inspect the raw error for 5xx / connectivity shapes
  // the classifier didn't specialise.
  const raw = err instanceof Error ? `${err.name} ${err.message}` : "";
  if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|getaddrinfo/i.test(raw)) {
    return "connectivity";
  }
  if (
    /\b(5\d{2})\b/.test(raw) &&
    !/\b(50[01]|503 Service Unavailable — )/.test(raw)
  ) {
    // Any 5xx other than 501 (Not Implemented — deterministic) counts
    // as provider_5xx. We deliberately don't match 4xx — those are
    // the deterministic bucket.
    return "provider_5xx";
  }
  return null;
}

/**
 * Build a classified error shape for a "some domains failed" run —
 * Phase 3 Week 2 (ADR-0002). The UI uses this to render a FailureBanner
 * above the per-domain badges; succeeded domains' results stay visible
 * underneath. `okDomains` / `failedDomains` are surfaced in the
 * message so the reviewer immediately sees the proportion.
 */
export function classifyPartialAnalysisFailure(opts: {
  okDomains: string[];
  failedDomains: string[];
}): ClassifiedError {
  const okList = opts.okDomains.join(", ") || "none";
  const failList = opts.failedDomains.join(", ");
  return {
    label: "Some domains failed this run",
    userMessage: `Analysis completed for ${opts.okDomains.length} domain(s) — ${okList} — but ${opts.failedDomains.length} failed: ${failList}. The succeeded domains' findings, risks, and scores are saved; only the failed domains need a retry.`,
    nextStep:
      "Click Retry to re-run analysis. The succeeded domains will be re-processed and overwrite their DRAFT rows; reviewed rows are preserved (review-lock discipline).",
    technicalDetail: `partial: ${opts.failedDomains.length}/${opts.okDomains.length + opts.failedDomains.length} domain(s) failed`,
    category: "ANALYSIS_PARTIAL_FAILURE",
    isRetryable: true,
    needsAdmin: false,
  };
}
