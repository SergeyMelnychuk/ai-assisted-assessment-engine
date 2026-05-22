import type { Provider } from "./model-registry";

/**
 * Provider credential status probe.
 *
 * Every provider adapter we load via `@ai-sdk/*` reads credentials from
 * a well-known set of env vars. The router itself is happy to try any
 * provider in the `Provider` union — the *request* only fails at call
 * time when the SDK throws an auth error. That's terrible UX for an
 * admin who picks "Vertex" from a dropdown and only finds out it's
 * unwired after triggering a live assessment.
 *
 * This module inspects `process.env` and reports, per provider, whether
 * the minimum credentials are present. The admin UI uses it to:
 *   1. Show a "Provider status" panel listing what's configured.
 *   2. Disable unconfigured providers in the override dropdown.
 *   3. Warn (rather than silently accept) if an operator tries to save
 *      an override pointing at an unconfigured provider.
 *
 * Credentials stay env-only by design — this project is deployed as a
 * single Next.js app with one set of upstream keys, not a multi-tenant
 * SaaS. A DB-backed credential vault is explicitly out of scope; if
 * that's ever needed, the consumer surface below is the seam to swap.
 */

export interface ProviderStatus {
  provider: Provider;
  configured: boolean;
  /**
   * Which env var(s) we looked at. Surfaced to the UI so an operator
   * who sees "not configured" knows exactly what to set without
   * cross-referencing docs.
   */
  envVars: readonly string[];
  /**
   * Short human-readable explanation — either "why this is considered
   * configured" or "what's missing".
   */
  note: string;
}

function hasEnv(...names: readonly string[]): boolean {
  return names.some((n) => {
    const v = process.env[n];
    return typeof v === "string" && v.trim().length > 0;
  });
}

export function probeProviderStatus(provider: Provider): ProviderStatus {
  switch (provider) {
    case "anthropic": {
      const envVars = ["ANTHROPIC_API_KEY"] as const;
      const ok = hasEnv(...envVars);
      return {
        provider,
        configured: ok,
        envVars,
        note: ok
          ? "ANTHROPIC_API_KEY is set."
          : "ANTHROPIC_API_KEY is not set — direct Anthropic calls will fail.",
      };
    }
    case "bedrock": {
      // AWS SDK's default credential chain accepts any of these. We
      // accept IAM-role deploys (no keys, just region) as configured.
      const envVars = [
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_PROFILE",
        "AWS_ROLE_ARN",
      ] as const;
      const ok = hasEnv(...envVars);
      return {
        provider,
        configured: ok,
        envVars,
        note: ok
          ? "AWS credential chain has at least one signal (region / key / profile / role)."
          : "No AWS env vars set — Bedrock calls will fail to resolve credentials.",
      };
    }
    case "openai": {
      const envVars = ["OPENAI_API_KEY"] as const;
      const ok = hasEnv(...envVars);
      return {
        provider,
        configured: ok,
        envVars,
        note: ok
          ? "OPENAI_API_KEY is set."
          : "OPENAI_API_KEY is not set — OpenAI calls and OpenAI embeddings will fail.",
      };
    }
    case "azure": {
      // `@ai-sdk/azure` requires both a resource name and an API key.
      const envVars = [
        "AZURE_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "AZURE_RESOURCE_NAME",
      ] as const;
      const hasKey = hasEnv("AZURE_API_KEY", "AZURE_OPENAI_API_KEY");
      const hasResource = hasEnv("AZURE_RESOURCE_NAME");
      const ok = hasKey && hasResource;
      return {
        provider,
        configured: ok,
        envVars,
        note: ok
          ? "Azure OpenAI API key + resource name are set."
          : !hasKey && !hasResource
            ? "Azure OpenAI is not configured — set AZURE_API_KEY (or AZURE_OPENAI_API_KEY) and AZURE_RESOURCE_NAME."
            : !hasKey
              ? "Missing AZURE_API_KEY / AZURE_OPENAI_API_KEY."
              : "Missing AZURE_RESOURCE_NAME.",
      };
    }
    case "vertex": {
      // Google Vertex needs a project + location and auth — either a
      // service-account JSON via GOOGLE_APPLICATION_CREDENTIALS, or
      // workload-identity on GCP where no env is required beyond the
      // project. We treat "project set" as the minimum signal.
      const envVars = [
        "GOOGLE_VERTEX_PROJECT",
        "GOOGLE_VERTEX_LOCATION",
        "GOOGLE_APPLICATION_CREDENTIALS",
      ] as const;
      const hasProject = hasEnv("GOOGLE_VERTEX_PROJECT");
      const hasAuth = hasEnv(
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_GENERATIVE_AI_API_KEY",
      );
      const ok = hasProject && hasAuth;
      return {
        provider,
        configured: ok,
        envVars,
        note: ok
          ? "Vertex project + credentials are set."
          : "Vertex is not configured — set GOOGLE_VERTEX_PROJECT and either GOOGLE_APPLICATION_CREDENTIALS (service account JSON path) or rely on workload identity.",
      };
    }
    case "mistral": {
      const envVars = ["MISTRAL_API_KEY"] as const;
      const ok = hasEnv(...envVars);
      return {
        provider,
        configured: ok,
        envVars,
        note: ok
          ? "MISTRAL_API_KEY is set."
          : "MISTRAL_API_KEY is not set — Mistral calls will fail.",
      };
    }
    default: {
      const _exhaust: never = provider;
      throw new Error(
        `[provider-status] unknown provider: ${String(_exhaust)}`,
      );
    }
  }
}

export function probeAllProviders(
  providers: readonly Provider[],
): ProviderStatus[] {
  return providers.map((p) => probeProviderStatus(p));
}
