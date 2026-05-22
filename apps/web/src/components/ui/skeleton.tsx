import { cn } from "@/lib/utils";

// Animated placeholder. Prefer over the loading spinner for list/detail
// surfaces so the layout shift is zero when real content arrives.
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
