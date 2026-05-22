"use client";

import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface AnswerFormProps {
  questionId: string;
  assessmentId: string;
  questionType: string;
  options: string[] | null;
  initialAnswerText?: string | null;
  initialAnswerData?: unknown;
  initialConfidence?: string | null;
  onAnswered?: () => void;
  onCancel?: () => void;
}

/**
 * Type-aware answer form. Branches on `questionType` to render the right
 * input; persists via `trpc.question.answer`. The parent list invalidates
 * on success so answered state + follow-up questions appear.
 *
 * NUMERIC and CONFIRMATION use `answerData`; FREE_TEXT/SINGLE/MULTI_CHOICE
 * also fill `answerText` for human readability in downstream exports.
 */
export function AnswerForm({
  questionId,
  assessmentId,
  questionType,
  options,
  initialAnswerText,
  initialAnswerData,
  initialConfidence,
  onAnswered,
  onCancel,
}: AnswerFormProps) {
  const utils = trpc.useUtils();
  const [text, setText] = useState(initialAnswerText ?? "");
  const [singleChoice, setSingleChoice] = useState<string>(
    typeof initialAnswerData === "string"
      ? initialAnswerData
      : initialAnswerText ?? "",
  );
  const [multiChoice, setMultiChoice] = useState<Set<string>>(
    new Set(
      Array.isArray(initialAnswerData) ? (initialAnswerData as string[]) : [],
    ),
  );
  const [numeric, setNumeric] = useState<string>(
    typeof initialAnswerData === "number"
      ? String(initialAnswerData)
      : initialAnswerText ?? "",
  );
  const [confirmation, setConfirmation] = useState<boolean>(
    typeof initialAnswerData === "boolean"
      ? (initialAnswerData as boolean)
      : false,
  );
  // FILE_UPLOAD-only state: the user can either pick files (uploaded
  // through the same /api/documents/upload endpoint as the Documents
  // tab) or point the agent at a path inside a connected repository.
  // Either is a valid answer; both can be combined.
  const [files, setFiles] = useState<File[]>([]);
  const [pathText, setPathText] = useState<string>(
    typeof initialAnswerData === "string"
      ? initialAnswerData
      : initialAnswerText ?? "",
  );
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState(initialConfidence ?? "");
  const [error, setError] = useState<string | null>(null);

  const answerMutation = trpc.question.answer.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.question.listByAssessment.invalidate({ assessmentId }),
        utils.question.getCoverage.invalidate({ assessmentId }),
      ]);
      onAnswered?.();
    },
    onError: (err) => setError(err.message),
  });

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const payload: Parameters<typeof answerMutation.mutate>[0] = {
      questionId,
      confidenceNote: note.trim() || undefined,
    };

    switch (questionType) {
      case "FREE_TEXT":
        if (!text.trim()) return setError("Please enter an answer.");
        payload.answerText = text.trim();
        break;
      case "SINGLE_CHOICE":
        if (!singleChoice) return setError("Pick one option.");
        payload.answerData = singleChoice;
        payload.answerText = singleChoice;
        break;
      case "MULTI_CHOICE": {
        if (multiChoice.size === 0) return setError("Pick at least one option.");
        const picks = Array.from(multiChoice);
        payload.answerData = picks;
        payload.answerText = picks.join(", ");
        break;
      }
      case "NUMERIC": {
        const n = Number(numeric);
        if (Number.isNaN(n)) return setError("Enter a number.");
        payload.answerData = n;
        payload.answerText = String(n);
        break;
      }
      case "CONFIRMATION":
        payload.answerData = confirmation;
        payload.answerText = confirmation ? "Yes" : "No";
        break;
      case "FILE_UPLOAD": {
        // Either uploads OR a repo path counts as a valid answer.
        // We don't insist on both; users may have just one source.
        const hasFiles = files.length > 0;
        const trimmedPath = pathText.trim();
        if (!hasFiles && !trimmedPath) {
          return setError(
            "Upload at least one file, or point us at a path in a connected repository.",
          );
        }

        // Upload files first (same endpoint as the Documents tab).
        // Sequential to surface per-file failures cleanly. Documents
        // land in the assessment's evidence stream automatically.
        const uploadedNames: string[] = [];
        if (hasFiles) {
          setUploading(true);
          try {
            for (const f of files) {
              const fd = new FormData();
              fd.append("assessmentId", assessmentId);
              fd.append("file", f);
              const res = await fetch("/api/documents/upload", {
                method: "POST",
                body: fd,
              });
              if (!res.ok) {
                const body = (await res
                  .json()
                  .catch(() => null)) as { error?: string } | null;
                const msg =
                  body?.error ?? `Upload failed (${res.status}) for ${f.name}`;
                setUploading(false);
                return setError(msg);
              }
              uploadedNames.push(f.name);
            }
          } catch (err) {
            setUploading(false);
            return setError(
              err instanceof Error ? err.message : "Upload failed",
            );
          }
          setUploading(false);
        }

        // Stitch a human-readable answer. The structured `answerData`
        // captures both halves so downstream synthesis can see the
        // file references and the repo path separately.
        const parts: string[] = [];
        if (uploadedNames.length > 0) {
          parts.push(
            `Uploaded ${uploadedNames.length} file${uploadedNames.length === 1 ? "" : "s"}: ${uploadedNames.join(", ")}`,
          );
        }
        if (trimmedPath) {
          parts.push(`Repository path: ${trimmedPath}`);
        }
        payload.answerText = parts.join(" · ");
        payload.answerData = {
          uploadedFiles: uploadedNames,
          repositoryPath: trimmedPath || null,
        };
        break;
      }
      default:
        if (!text.trim()) return setError("Please enter an answer.");
        payload.answerText = text.trim();
    }

    answerMutation.mutate(payload);
  }

  const pending = answerMutation.isPending || uploading;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {questionType === "FREE_TEXT" && (
        <Textarea
          placeholder="Your answer…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={pending}
          rows={3}
        />
      )}

      {questionType === "SINGLE_CHOICE" && options && options.length > 0 && (
        <div className="grid gap-2">
          {options.map((opt) => (
            <label
              key={opt}
              className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                singleChoice === opt
                  ? "border-primary bg-primary/5"
                  : "border-input hover:bg-muted/40"
              }`}
            >
              <input
                type="radio"
                name={`sc-${questionId}`}
                className="mt-0.5"
                checked={singleChoice === opt}
                onChange={() => setSingleChoice(opt)}
                disabled={pending}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}

      {questionType === "MULTI_CHOICE" && options && options.length > 0 && (
        <div className="grid gap-2">
          {options.map((opt) => (
            <label
              key={opt}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-muted/40"
            >
              <input
                type="checkbox"
                checked={multiChoice.has(opt)}
                onChange={() => {
                  setMultiChoice((prev) => {
                    const next = new Set(prev);
                    if (next.has(opt)) next.delete(opt);
                    else next.add(opt);
                    return next;
                  });
                }}
                disabled={pending}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}

      {questionType === "NUMERIC" && (
        <Input
          type="number"
          inputMode="decimal"
          placeholder="Enter a number"
          value={numeric}
          onChange={(e) => setNumeric(e.target.value)}
          disabled={pending}
        />
      )}

      {questionType === "CONFIRMATION" && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmation}
            onChange={(e) => setConfirmation(e.target.checked)}
            disabled={pending}
          />
          Yes, confirmed
        </label>
      )}

      {questionType === "FILE_UPLOAD" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Upload the relevant file(s) <strong>or</strong> point us at a
            path inside a connected repository — either is enough; you can
            do both if it helps.
          </p>
          <div className="space-y-1">
            <label
              htmlFor={`file-${questionId}`}
              className="text-xs font-medium"
            >
              Upload file(s)
            </label>
            <input
              id={`file-${questionId}`}
              type="file"
              multiple
              disabled={pending}
              onChange={(e) =>
                setFiles(
                  e.target.files ? Array.from(e.target.files) : [],
                )
              }
              className="block w-full rounded-md border bg-background px-3 py-1.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
            />
            {files.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {files.length} file{files.length === 1 ? "" : "s"} selected:{" "}
                {files.map((f) => f.name).join(", ")}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <label
              htmlFor={`path-${questionId}`}
              className="text-xs font-medium"
            >
              Or repository path
            </label>
            <Textarea
              id={`path-${questionId}`}
              placeholder="e.g. acme/api/infra/cdk or owner/repo:path/to/terraform"
              value={pathText}
              onChange={(e) => setPathText(e.target.value)}
              disabled={pending}
              rows={2}
            />
            <p className="text-[11px] text-muted-foreground">
              Free-form. Paste a path inside one of the repositories you
              connected in the workflow, or describe where the artefact
              lives.
            </p>
          </div>
        </div>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Confidence / source note (optional)
        </summary>
        <Textarea
          placeholder="Where did this come from? How sure are we?"
          className="mt-2"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={pending}
          rows={2}
        />
      </details>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {uploading
            ? "Uploading…"
            : pending
              ? "Saving…"
              : "Save answer"}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
