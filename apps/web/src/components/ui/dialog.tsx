"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

/**
 * shadcn-style Dialog primitives over `@radix-ui/react-dialog`.
 *
 * Slim wrapper — no portal customisation, no theme tokens beyond what
 * the rest of the app already uses (`bg-background`, `text-foreground`,
 * `border`, `text-muted-foreground`). The variants this codebase needs
 * for the workflow popup containers are a wide content surface that
 * scrolls vertically; that's the default styling here.
 *
 * Why hand-rolled rather than `npx shadcn add dialog`:
 *   - The shadcn CLI flow has dependency-tree opinions we don't share
 *     (it pulls extra Radix primitives the project doesn't need).
 *   - We already use Tailwind + raw Radix elsewhere; consistency wins.
 *
 * Use: `<Dialog open={x} onOpenChange={setX}><DialogContent>…</DialogContent></Dialog>`.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className = "", ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={
        // Soft scrim — keeps the page legible behind so the user
        // doesn't lose context entirely.
        "fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] " +
        "data-[state=open]:animate-in data-[state=closed]:animate-out " +
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 " +
        className
      }
      {...props}
    />
  );
});

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Caps content width. The workflow step popups want `wide` (4xl). */
  size?: "sm" | "md" | "lg" | "xl" | "wide";
}

const SIZE_CLASS: Record<NonNullable<DialogContentProps["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
  wide: "max-w-5xl",
};

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { className = "", size = "wide", children, ...props },
  ref,
) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={
          "fixed left-1/2 top-1/2 z-50 flex w-[95vw] -translate-x-1/2 -translate-y-1/2 " +
          // flex-col so the three slots (header, scrollable body,
          // footer) compose vertically. The body itself owns the
          // scroll — see `DialogBody` below — instead of the whole
          // dialog scrolling, which previously fought the sticky
          // footer.
          "flex-col gap-4 border bg-background p-6 shadow-lg sm:rounded-lg " +
          // Cap the dialog at 90vh; the body region inside grows
          // to flex-1 and scrolls when content exceeds the cap.
          "max-h-[90vh] overflow-hidden " +
          SIZE_CLASS[size] + " " + className
        }
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

/**
 * Scrollable middle region of a Dialog. Wrap the body content in
 * this so headers + footers stay anchored while the middle scrolls
 * independently. Without it, long bodies push the footer offscreen.
 */
export function DialogBody({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={
        // flex-1 takes all the remaining space inside the dialog.
        // overflow-y-auto fires the internal scroll. The negative
        // margin + padding trick keeps content edge-to-edge with the
        // dialog's existing 24px padding while letting the scrollbar
        // sit on the dialog's right edge instead of inside the
        // padded zone.
        "-mx-6 flex-1 overflow-y-auto px-6 " + className
      }
      {...props}
    />
  );
}

export function DialogHeader({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={"flex flex-col space-y-1.5 pr-8 " + className}
      {...props}
    />
  );
}

export function DialogFooter({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  // The DialogContent uses flex-col and the DialogBody is the
  // scrollable middle (flex-1). The footer is just a regular block
  // at the end of the column — anchored by virtue of being outside
  // the scroll region. No sticky needed.
  return (
    <div
      className={
        "-mx-6 -mb-6 flex shrink-0 flex-col-reverse gap-2 " +
        "border-t bg-background px-6 py-4 sm:flex-row sm:justify-end " +
        className
      }
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className = "", ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={"text-lg font-semibold tracking-tight " + className}
      {...props}
    />
  );
});

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className = "", ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={"text-sm text-muted-foreground " + className}
      {...props}
    />
  );
});
