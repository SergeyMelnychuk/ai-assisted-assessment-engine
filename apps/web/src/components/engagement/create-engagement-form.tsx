"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FieldErrors = Partial<Record<"name" | "clientName" | "industry", string[]>>;

export function CreateEngagementForm() {
  const router = useRouter();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [industry, setIndustry] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = trpc.engagement.create.useMutation({
    onSuccess: async (engagement) => {
      // Invalidate the list so the new row appears if the user hits back.
      await utils.engagement.list.invalidate();
      router.push(`/engagements/${engagement.id}`);
    },
    onError: (err) => {
      const zod = err.data?.zodError;
      if (zod?.fieldErrors) {
        setFieldErrors(zod.fieldErrors as FieldErrors);
        setFormError("Please fix the fields below.");
      } else {
        setFormError(err.message || "Couldn't create engagement");
      }
    },
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);
    createMutation.mutate({
      name: name.trim(),
      clientName: clientName.trim(),
      // Only send `industry` if the user typed something — the procedure
      // declares it as optional; an empty string would pass zod but pollute
      // the DB with "".
      industry: industry.trim() ? industry.trim() : undefined,
    });
  }

  const submitting = createMutation.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <Label htmlFor="name">Engagement name</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={200}
          placeholder="e.g. Acme Cloud Modernization Assessment"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1"
        />
        {fieldErrors.name?.[0] ? (
          <p className="mt-1 text-xs text-destructive">{fieldErrors.name[0]}</p>
        ) : null}
      </div>

      <div>
        <Label htmlFor="clientName">Client</Label>
        <Input
          id="clientName"
          name="clientName"
          required
          maxLength={200}
          placeholder="e.g. Acme Corporation"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className="mt-1"
        />
        {fieldErrors.clientName?.[0] ? (
          <p className="mt-1 text-xs text-destructive">
            {fieldErrors.clientName[0]}
          </p>
        ) : null}
      </div>

      <div>
        <Label htmlFor="industry">
          Industry <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="industry"
          name="industry"
          placeholder="e.g. Financial Services"
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          className="mt-1"
        />
        {fieldErrors.industry?.[0] ? (
          <p className="mt-1 text-xs text-destructive">
            {fieldErrors.industry[0]}
          </p>
        ) : null}
      </div>

      {formError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create engagement"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting}
          onClick={() => router.push("/engagements")}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
