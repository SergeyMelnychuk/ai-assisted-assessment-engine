"use client";

import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type RateCardRow = RouterOutputs["rateCard"]["list"][number];

interface RateRow {
  role: string;
  seniority: "JUNIOR" | "MID" | "SENIOR" | "LEAD" | "PRINCIPAL";
  hourlyRate: number;
  dailyRate?: number;
}

const SENIORITIES: RateRow["seniority"][] = [
  "JUNIOR",
  "MID",
  "SENIOR",
  "LEAD",
  "PRINCIPAL",
];

interface DraftCard {
  id?: string;
  name: string;
  currency: string;
  validFrom: string;
  validTo: string;
  isDefault: boolean;
  rates: RateRow[];
}

function emptyDraft(): DraftCard {
  return {
    name: "",
    currency: "USD",
    validFrom: new Date().toISOString().slice(0, 10),
    validTo: "",
    isDefault: false,
    rates: [],
  };
}

function toDraft(card: RateCardRow): DraftCard {
  const rawRates = Array.isArray(card.rates) ? (card.rates as unknown[]) : [];
  const rates: RateRow[] = rawRates.map((r) => {
    const obj = (r ?? {}) as Partial<RateRow>;
    return {
      role: String(obj.role ?? ""),
      seniority: (obj.seniority ?? "MID") as RateRow["seniority"],
      hourlyRate: Number(obj.hourlyRate ?? 0),
      dailyRate:
        obj.dailyRate === undefined || obj.dailyRate === null
          ? undefined
          : Number(obj.dailyRate),
    };
  });
  return {
    id: card.id,
    name: card.name,
    currency: card.currency,
    validFrom: new Date(card.validFrom).toISOString().slice(0, 10),
    validTo: card.validTo
      ? new Date(card.validTo).toISOString().slice(0, 10)
      : "",
    isDefault: card.isDefault,
    rates,
  };
}

export function RateCardsAdmin() {
  const utils = trpc.useUtils();
  const listQuery = trpc.rateCard.list.useQuery();

  const [mode, setMode] = useState<
    { kind: "list" } | { kind: "edit"; draft: DraftCard } | { kind: "create"; draft: DraftCard }
  >({ kind: "list" });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshList = async () => {
    await utils.rateCard.list.invalidate();
  };

  const createMutation = trpc.rateCard.create.useMutation({
    onSuccess: async () => {
      await refreshList();
      setMode({ kind: "list" });
    },
    onError: (e) => setError(e.message || "Create failed"),
  });

  const updateMutation = trpc.rateCard.update.useMutation({
    onSuccess: async () => {
      await refreshList();
      setMode({ kind: "list" });
    },
    onError: (e) => setError(e.message || "Update failed"),
  });

  const deleteMutation = trpc.rateCard.delete.useMutation({
    onSuccess: async () => {
      await refreshList();
      setConfirmDeleteId(null);
    },
    onError: (e) => setError(e.message || "Delete failed"),
  });

  const setDefaultMutation = trpc.rateCard.setDefault.useMutation({
    onSuccess: () => refreshList(),
    onError: (e) => setError(e.message || "Couldn't set default"),
  });

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    setDefaultMutation.isPending;

  if (listQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {listQuery.error.message}
      </p>
    );
  }

  const cards = listQuery.data ?? [];

  if (mode.kind !== "list") {
    return (
      <RateCardEditor
        draft={mode.draft}
        busy={busy}
        error={error}
        onChange={(next) =>
          setMode((prev) =>
            prev.kind === "list" ? prev : { ...prev, draft: next },
          )
        }
        onCancel={() => {
          setError(null);
          setMode({ kind: "list" });
        }}
        onSubmit={(draft) => {
          setError(null);
          const validFrom = new Date(`${draft.validFrom}T00:00:00Z`);
          const validTo = draft.validTo
            ? new Date(`${draft.validTo}T00:00:00Z`)
            : null;
          if (Number.isNaN(validFrom.getTime())) {
            setError("Invalid valid-from date");
            return;
          }
          if (validTo && Number.isNaN(validTo.getTime())) {
            setError("Invalid valid-to date");
            return;
          }
          const sanitizedRates = draft.rates.map((r) => ({
            role: r.role.trim(),
            seniority: r.seniority,
            hourlyRate: Number(r.hourlyRate),
            dailyRate:
              r.dailyRate === undefined || Number.isNaN(Number(r.dailyRate))
                ? undefined
                : Number(r.dailyRate),
          }));
          if (mode.kind === "create") {
            createMutation.mutate({
              name: draft.name.trim(),
              currency: draft.currency.trim() || "USD",
              rates: sanitizedRates,
              validFrom,
              validTo,
              isDefault: draft.isDefault,
            });
          } else if (draft.id) {
            updateMutation.mutate({
              id: draft.id,
              name: draft.name.trim(),
              currency: draft.currency.trim() || "USD",
              rates: sanitizedRates,
              validFrom,
              validTo,
              isDefault: draft.isDefault,
            });
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {cards.length} rate card{cards.length === 1 ? "" : "s"}
        </p>
        <Button
          onClick={() => {
            setError(null);
            setMode({ kind: "create", draft: emptyDraft() });
          }}
        >
          New rate card
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {cards.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No rate cards</CardTitle>
            <CardDescription>
              Create one above, or run{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                pnpm db:seed
              </code>{" "}
              to load the default from the knowledge-seed package.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        cards.map((card) => (
          <RateCardSummary
            key={card.id}
            card={card}
            busy={busy}
            confirmingDelete={confirmDeleteId === card.id}
            onEdit={() => {
              setError(null);
              setMode({ kind: "edit", draft: toDraft(card) });
            }}
            onDeleteRequest={() => {
              setError(null);
              setConfirmDeleteId(card.id);
            }}
            onDeleteConfirm={() => deleteMutation.mutate({ id: card.id })}
            onDeleteCancel={() => setConfirmDeleteId(null)}
            onSetDefault={() => setDefaultMutation.mutate({ id: card.id })}
          />
        ))
      )}
    </div>
  );
}

function RateCardSummary({
  card,
  busy,
  confirmingDelete,
  onEdit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  onSetDefault,
}: {
  card: RateCardRow;
  busy: boolean;
  confirmingDelete: boolean;
  onEdit: () => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  onSetDefault: () => void;
}) {
  const rates = Array.isArray(card.rates)
    ? (card.rates as unknown as RateRow[])
    : [];
  const inUseCount = card._count.estimates;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {card.name}
              {card.isDefault ? (
                <span className="ml-2 inline-flex items-center rounded-full border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-normal text-foreground">
                  default
                </span>
              ) : null}
            </CardTitle>
            <CardDescription>
              {card.currency} · {rates.length} rate{rates.length === 1 ? "" : "s"} ·{" "}
              referenced by {inUseCount} estimate
              {inUseCount === 1 ? "" : "s"} · valid from{" "}
              {new Date(card.validFrom).toLocaleDateString(undefined, {
                dateStyle: "medium",
              })}
              {card.validTo
                ? ` – ${new Date(card.validTo).toLocaleDateString(undefined, {
                    dateStyle: "medium",
                  })}`
                : ""}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {!card.isDefault ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={onSetDefault}
              >
                Set default
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" disabled={busy} onClick={onEdit}>
              Edit
            </Button>
            {confirmingDelete ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={onDeleteConfirm}
                >
                  Confirm delete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onDeleteCancel}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || inUseCount > 0}
                title={
                  inUseCount > 0
                    ? "Referenced by estimates — can't delete"
                    : undefined
                }
                onClick={onDeleteRequest}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      {rates.length > 0 ? (
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Seniority</th>
                  <th className="px-3 py-2 text-right">Hourly</th>
                  <th className="px-3 py-2 text-right">Daily</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r, i) => (
                  <tr
                    key={`${r.role}-${r.seniority}-${i}`}
                    className="border-t"
                  >
                    <td className="px-3 py-2 font-medium">{r.role}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {String(r.seniority).toLowerCase()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(r.hourlyRate, card.currency)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {r.dailyRate !== undefined
                        ? formatMoney(r.dailyRate, card.currency)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function RateCardEditor({
  draft,
  busy,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: DraftCard;
  busy: boolean;
  error: string | null;
  onChange: (next: DraftCard) => void;
  onCancel: () => void;
  onSubmit: (draft: DraftCard) => void;
}) {
  const knownRoles = useMemo(() => {
    const seen = new Set<string>();
    for (const r of draft.rates) {
      if (r.role.trim()) seen.add(r.role.trim());
    }
    return Array.from(seen).sort();
  }, [draft.rates]);

  function setRate(index: number, patch: Partial<RateRow>) {
    const next = draft.rates.slice();
    next[index] = { ...next[index], ...patch };
    onChange({ ...draft, rates: next });
  }

  function addRate() {
    onChange({
      ...draft,
      rates: [
        ...draft.rates,
        { role: "", seniority: "MID", hourlyRate: 0, dailyRate: undefined },
      ],
    });
  }

  function removeRate(index: number) {
    const next = draft.rates.slice();
    next.splice(index, 1);
    onChange({ ...draft, rates: next });
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            required
            maxLength={200}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="currency">Currency</Label>
          <Input
            id="currency"
            value={draft.currency}
            onChange={(e) => onChange({ ...draft, currency: e.target.value })}
            required
            maxLength={8}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="validFrom">Valid from</Label>
          <Input
            id="validFrom"
            type="date"
            value={draft.validFrom}
            onChange={(e) => onChange({ ...draft, validFrom: e.target.value })}
            required
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="validTo">
            Valid to <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="validTo"
            type="date"
            value={draft.validTo}
            onChange={(e) => onChange({ ...draft, validTo: e.target.value })}
            className="mt-1"
          />
        </div>
        <div className="sm:col-span-2 flex items-center gap-2">
          <input
            id="isDefault"
            type="checkbox"
            checked={draft.isDefault}
            onChange={(e) => onChange({ ...draft, isDefault: e.target.checked })}
            className="h-4 w-4"
          />
          <Label htmlFor="isDefault" className="cursor-pointer">
            Default rate card (unsets the flag on any other card)
          </Label>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Rates</h2>
          <Button type="button" variant="secondary" size="sm" onClick={addRate}>
            Add row
          </Button>
        </div>

        {draft.rates.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No rates yet. Add a row to register the first role.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Seniority</th>
                  <th className="px-3 py-2 text-right">Hourly</th>
                  <th className="px-3 py-2 text-right">Daily (opt.)</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {draft.rates.map((row, i) => (
                  <tr key={i} className="border-t align-top">
                    <td className="px-2 py-1.5">
                      <Input
                        value={row.role}
                        onChange={(e) => setRate(i, { role: e.target.value })}
                        placeholder="e.g. Backend Developer"
                        list="known-roles"
                        required
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={row.seniority}
                        onChange={(e) =>
                          setRate(i, {
                            seniority: e.target.value as RateRow["seniority"],
                          })
                        }
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      >
                        {SENIORITIES.map((s) => (
                          <option key={s} value={s}>
                            {s.toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={Number.isFinite(row.hourlyRate) ? row.hourlyRate : 0}
                        onChange={(e) =>
                          setRate(i, { hourlyRate: Number(e.target.value) })
                        }
                        className="text-right"
                        required
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={
                          row.dailyRate === undefined ? "" : row.dailyRate
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setRate(i, {
                            dailyRate: v === "" ? undefined : Number(v),
                          });
                        }}
                        className="text-right"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeRate(i)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="known-roles">
              {knownRoles.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
        )}

        {/* Second Add-row affordance directly below the table so a user
            who just finished filling out the last row can keep typing
            without scrolling back up past the rates table to the
            header-level button. */}
        {draft.rates.length > 0 ? (
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addRate}
            >
              Add row
            </Button>
          </div>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : draft.id ? "Save changes" : "Create rate card"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString()}`;
  }
}
