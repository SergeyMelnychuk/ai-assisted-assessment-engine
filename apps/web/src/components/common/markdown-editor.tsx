"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Markdown editor with two tabs: raw Markdown source and a WYSIWYG
 * rich-text view. Both views read and write the same markdown string,
 * round-tripped via the `tiptap-markdown` extension (markdown → HTML
 * on mount, HTML → markdown on every edit).
 *
 * Why a tabbed UI rather than a single hybrid editor: reviewers who
 * care about exact markdown structure (lists, headings, link refs)
 * want a literal source view; reviewers who just want to write a
 * paragraph or fix a bullet want a normal rich-text feel. Both
 * audiences exist on the deliverable-section editor, so we give them
 * the choice and keep the underlying value as canonical markdown.
 *
 * Round-trip notes:
 *   - tiptap-markdown serialises to a stable subset of CommonMark.
 *     Edits in rich text may normalise whitespace and re-flow lists,
 *     but semantic content stays identical.
 *   - If the source markdown contains constructs the rich-text view
 *     can't render (e.g. raw HTML tables), the WYSIWYG tab will show
 *     a degraded view but the markdown tab is always the source of
 *     truth.
 */
export interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Min height of the editor body, e.g. "55vh". */
  minHeight?: string;
  /** Default tab on first mount. */
  defaultTab?: "markdown" | "richtext";
  /** Element id for the editor body — pairs with an external label. */
  id?: string;
}

export function MarkdownEditor({
  value,
  onChange,
  disabled,
  minHeight = "55vh",
  defaultTab = "richtext",
  id,
}: MarkdownEditorProps) {
  const [tab, setTab] = useState<"markdown" | "richtext">(defaultTab);

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <TabButton
          active={tab === "richtext"}
          onClick={() => setTab("richtext")}
        >
          Rich text
        </TabButton>
        <TabButton
          active={tab === "markdown"}
          onClick={() => setTab("markdown")}
        >
          Markdown
        </TabButton>
      </div>

      {tab === "richtext" ? (
        <RichTextView
          value={value}
          onChange={onChange}
          disabled={disabled}
          minHeight={minHeight}
          id={id}
        />
      ) : (
        <MarkdownSourceView
          value={value}
          onChange={onChange}
          disabled={disabled}
          minHeight={minHeight}
          id={id}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded px-3 py-1 text-xs font-medium transition-colors " +
        (active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground")
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function MarkdownSourceView({
  value,
  onChange,
  disabled,
  minHeight,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  minHeight: string;
  id?: string;
}) {
  return (
    <Textarea
      id={id}
      className="border-0 font-mono text-sm focus-visible:ring-0"
      style={{ minHeight }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      spellCheck={false}
    />
  );
}

function RichTextView({
  value,
  onChange,
  disabled,
  minHeight,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  minHeight: string;
  id?: string;
}) {
  // Hold the latest `onChange` in a ref so the Tiptap editor instance
  // (which is created once via `useEditor`) always calls the freshest
  // callback without recreating itself on every parent re-render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // The Markdown extension owns markdown parsing + serialization;
        // the StarterKit defaults are fine for the rest.
        codeBlock: { HTMLAttributes: { class: "rounded bg-muted p-2 text-xs" } },
      }),
      Markdown.configure({
        // Keep behaviour close to GitHub-flavoured: hard line breaks,
        // preserve trailing whitespace differences silently. The
        // serializer is forgiving; reviewers who need exact control
        // switch to the Markdown tab.
        html: false,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    // The editor is created in client-only context (this file is
    // marked "use client"), but Next.js still hydrates the tree on the
    // server first; setting `immediatelyRender: false` avoids the
    // mismatch warning the Tiptap docs call out.
    immediatelyRender: false,
    content: value,
    editable: !disabled,
    onUpdate({ editor }) {
      // tiptap-markdown attaches a `storage.markdown.getMarkdown()`
      // helper to the editor. Push the new value back to the parent so
      // the markdown string stays the source of truth.
      const md = (
        editor.storage as unknown as { markdown: { getMarkdown(): string } }
      ).markdown.getMarkdown();
      onChangeRef.current(md);
    },
    editorProps: {
      attributes: {
        // Use the same prose-friendly styling as the GuideMarkdown
        // viewer so the rich-text view looks like the rendered preview.
        class:
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none",
        id: id ?? "",
      },
    },
  });

  // When the parent value changes by an outside route (e.g. user
  // switched to the Markdown tab, edited the source, switched back),
  // sync the editor content. Skip if the editor already holds the
  // same markdown — otherwise we'd thrash the selection.
  useEffect(() => {
    if (!editor) return;
    const current = (
      editor.storage as unknown as { markdown: { getMarkdown(): string } }
    ).markdown.getMarkdown();
    if (current.trim() === value.trim()) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [value, editor]);

  // Honour `disabled` after the editor is built.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  return (
    <div className="space-y-0">
      {editor ? <RichTextToolbar editor={editor} disabled={disabled} /> : null}
      <div
        className="overflow-y-auto px-3 py-2 text-sm"
        style={{ minHeight }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function RichTextToolbar({
  editor,
  disabled,
}: {
  editor: Editor;
  disabled?: boolean;
}) {
  const btn = (props: {
    label: string;
    active?: boolean;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <Button
      type="button"
      size="sm"
      variant={props.active ? "secondary" : "ghost"}
      className="h-7 px-2 text-xs"
      disabled={disabled || props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </Button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1 border-b bg-muted/20 px-2 py-1">
      {btn({
        label: "B",
        active: editor.isActive("bold"),
        onClick: () => editor.chain().focus().toggleBold().run(),
      })}
      {btn({
        label: "I",
        active: editor.isActive("italic"),
        onClick: () => editor.chain().focus().toggleItalic().run(),
      })}
      {btn({
        label: "S",
        active: editor.isActive("strike"),
        onClick: () => editor.chain().focus().toggleStrike().run(),
      })}
      {btn({
        label: "Code",
        active: editor.isActive("code"),
        onClick: () => editor.chain().focus().toggleCode().run(),
      })}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {btn({
        label: "H1",
        active: editor.isActive("heading", { level: 1 }),
        onClick: () =>
          editor.chain().focus().toggleHeading({ level: 1 }).run(),
      })}
      {btn({
        label: "H2",
        active: editor.isActive("heading", { level: 2 }),
        onClick: () =>
          editor.chain().focus().toggleHeading({ level: 2 }).run(),
      })}
      {btn({
        label: "H3",
        active: editor.isActive("heading", { level: 3 }),
        onClick: () =>
          editor.chain().focus().toggleHeading({ level: 3 }).run(),
      })}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {btn({
        label: "• List",
        active: editor.isActive("bulletList"),
        onClick: () => editor.chain().focus().toggleBulletList().run(),
      })}
      {btn({
        label: "1. List",
        active: editor.isActive("orderedList"),
        onClick: () => editor.chain().focus().toggleOrderedList().run(),
      })}
      {btn({
        label: "❝",
        active: editor.isActive("blockquote"),
        onClick: () => editor.chain().focus().toggleBlockquote().run(),
      })}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      {btn({
        label: "↶",
        onClick: () => editor.chain().focus().undo().run(),
        disabled: !editor.can().chain().focus().undo().run(),
      })}
      {btn({
        label: "↷",
        onClick: () => editor.chain().focus().redo().run(),
        disabled: !editor.can().chain().focus().redo().run(),
      })}
    </div>
  );
}
