import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc/router";

// Typed hooks. Import as `import { trpc } from "@/lib/trpc";` anywhere in a
// client component and get `trpc.engagement.list.useQuery()` etc.
export const trpc = createTRPCReact<AppRouter>();

// Ergonomic helpers so components can annotate their own props / state
// without reaching into tRPC internals:
//   const engagements: RouterOutputs["engagement"]["list"] = ...
//   function onSubmit(input: RouterInputs["engagement"]["create"]) { ... }
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
