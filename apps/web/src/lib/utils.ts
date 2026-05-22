import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Standard shadcn utility: merges arbitrary className inputs and then
// de-conflicts overlapping Tailwind classes (e.g. "px-4 px-6" → "px-6").
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
