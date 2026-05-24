import { describe, expect, it } from "vitest";
import {
  containsMarkdownSyntax,
  parseMarkdown,
  renderBlocksToDocx,
  renderBlocksToPptx,
  renderBlocksToXlsx,
  stripMarkdownSyntax,
} from "./markdown-to-ooxml";

/**
 * The markdown subset the AI section pass produces is narrow: bold,
 * italic, bulleted lists, numbered lists, paragraph breaks. These
 * tests lock in:
 *   - the detector recognises every variant of those, and rejects
 *     plain prose to avoid the more expensive paragraph-splice path
 *     in the filler.
 *   - the parser emits the expected block + run structure.
 *   - the per-format renderers produce OOXML strings (or exceljs
 *     RichText) carrying the right native primitives — bullets
 *     show up as `<a:buChar>`, bold as `<w:b/>` / `b="1"`, etc.
 */

describe("containsMarkdownSyntax", () => {
  it("flags bold", () => {
    expect(containsMarkdownSyntax("**bold** text")).toBe(true);
  });
  it("flags italic — both markers", () => {
    expect(containsMarkdownSyntax("the *important* part")).toBe(true);
    expect(containsMarkdownSyntax("an _italic_ word")).toBe(true);
  });
  it("flags bullet lists", () => {
    expect(containsMarkdownSyntax("- first\n- second")).toBe(true);
    expect(containsMarkdownSyntax("* alt marker\n* still works")).toBe(true);
  });
  it("flags numbered lists", () => {
    expect(containsMarkdownSyntax("1. one\n2. two")).toBe(true);
  });
  it("returns false for plain prose", () => {
    expect(containsMarkdownSyntax("Just a regular paragraph.")).toBe(false);
    expect(containsMarkdownSyntax("Cost is $200 * 5 hours = $1000.")).toBe(
      false,
    );
    expect(containsMarkdownSyntax("")).toBe(false);
  });
  it("does not flag asterisks adjacent to whitespace (multiplication)", () => {
    expect(containsMarkdownSyntax("3 * 4")).toBe(false);
  });
});

describe("parseMarkdown", () => {
  it("parses a single paragraph with inline bold", () => {
    const blocks = parseMarkdown("This is **important** copy.");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        runs: [
          { kind: "text", text: "This is " },
          { kind: "bold", text: "important" },
          { kind: "text", text: " copy." },
        ],
      },
    ]);
  });

  it("parses a bullet list", () => {
    const blocks = parseMarkdown("- first item\n- second item");
    expect(blocks).toEqual([
      { type: "bulletItem", runs: [{ kind: "text", text: "first item" }] },
      { type: "bulletItem", runs: [{ kind: "text", text: "second item" }] },
    ]);
  });

  it("parses a numbered list", () => {
    const blocks = parseMarkdown("1. one\n2. two");
    expect(blocks).toEqual([
      {
        type: "numberedItem",
        index: 1,
        runs: [{ kind: "text", text: "one" }],
      },
      {
        type: "numberedItem",
        index: 2,
        runs: [{ kind: "text", text: "two" }],
      },
    ]);
  });

  it("mixes paragraphs and lists", () => {
    const blocks = parseMarkdown(
      "Intro paragraph.\n\n- bullet one\n- bullet two\n\nClosing line.",
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "bulletItem",
      "bulletItem",
      "paragraph",
    ]);
  });

  it("does not parse bold inside a bullet line as a list marker", () => {
    // `**bold**` shouldn't be mistaken for a `* italic` opening at
    // the start of the line.
    const blocks = parseMarkdown("- **bold** text");
    expect(blocks).toEqual([
      {
        type: "bulletItem",
        runs: [
          { kind: "bold", text: "bold" },
          { kind: "text", text: " text" },
        ],
      },
    ]);
  });

  it("preserves trailing punctuation around italic", () => {
    const blocks = parseMarkdown("the _important_ bit.");
    expect(blocks[0]).toEqual({
      type: "paragraph",
      runs: [
        { kind: "text", text: "the " },
        { kind: "italic", text: "important" },
        { kind: "text", text: " bit." },
      ],
    });
  });
});

describe("stripMarkdownSyntax", () => {
  it("strips bold + italic markers", () => {
    expect(stripMarkdownSyntax("a **bold** and _italic_ word")).toBe(
      "a bold and italic word",
    );
  });
  it("converts bullet markers to bullet character", () => {
    expect(stripMarkdownSyntax("- one\n- two")).toBe("• one\n• two");
  });
  it("leaves prose alone", () => {
    expect(stripMarkdownSyntax("just text")).toBe("just text");
  });
});

describe("renderBlocksToDocx", () => {
  it("emits a plain paragraph with preserved pPr", () => {
    const blocks = parseMarkdown("hello world");
    const xml = renderBlocksToDocx(blocks, "<w:jc w:val=\"left\"/>");
    expect(xml).toContain("<w:p>");
    expect(xml).toContain("<w:pPr><w:jc w:val=\"left\"/></w:pPr>");
    expect(xml).toContain("<w:t xml:space=\"preserve\">hello world</w:t>");
  });

  it("emits a bold run wrapped in <w:b/>", () => {
    const xml = renderBlocksToDocx(parseMarkdown("**bold**"), "");
    expect(xml).toContain("<w:rPr><w:b/></w:rPr>");
    expect(xml).toContain(">bold</w:t>");
  });

  it("emits bullet items with leading • character", () => {
    const xml = renderBlocksToDocx(parseMarkdown("- first\n- second"), "");
    // Two paragraphs, each starting with the bullet character.
    const paraCount = (xml.match(/<w:p>/g) ?? []).length;
    expect(paraCount).toBe(2);
    expect(xml).toContain("• ");
  });

  it("escapes XML special characters in run text", () => {
    const xml = renderBlocksToDocx(parseMarkdown("a < b & c"), "");
    expect(xml).toContain("a &lt; b &amp; c");
    expect(xml).not.toContain("a < b & c"); // unescaped form gone
  });
});

describe("renderBlocksToPptx", () => {
  it("emits a paragraph with the preserved pPr inner content", () => {
    const xml = renderBlocksToPptx(parseMarkdown("hello"), "<a:lnSpc/>");
    expect(xml).toContain("<a:p>");
    expect(xml).toContain("<a:pPr><a:lnSpc/>");
    expect(xml).toContain("<a:t>hello</a:t>");
  });

  it("emits bullet items with <a:buChar>", () => {
    const xml = renderBlocksToPptx(parseMarkdown("- one\n- two"), "");
    expect(xml).toContain("<a:buChar char=\"•\"/>");
    const buCount = (xml.match(/<a:buChar/g) ?? []).length;
    expect(buCount).toBe(2);
  });

  it("emits numbered items with <a:buAutoNum>", () => {
    const xml = renderBlocksToPptx(parseMarkdown("1. one\n2. two"), "");
    expect(xml).toContain("<a:buAutoNum type=\"arabicPeriod\"/>");
  });

  it("emits bold runs with b=\"1\"", () => {
    const xml = renderBlocksToPptx(parseMarkdown("**strong**"), "");
    expect(xml).toContain("b=\"1\"");
    expect(xml).toContain("<a:t>strong</a:t>");
  });
});

describe("renderBlocksToXlsx", () => {
  it("emits richText runs for bold inline", () => {
    const rt = renderBlocksToXlsx(parseMarkdown("plain **bold** trail"));
    expect(rt.richText).toEqual([
      { text: "plain " },
      { font: { bold: true }, text: "bold" },
      { text: " trail" },
    ]);
  });

  it("flattens bullets to leading-• lines with newline separators", () => {
    const rt = renderBlocksToXlsx(parseMarkdown("- one\n- two"));
    // Joined runs make a single string we can inspect cleanly.
    const joined = rt.richText.map((r) => r.text).join("");
    expect(joined).toBe("• one\n• two");
  });

  it("returns an empty-text run when the input is empty", () => {
    const rt = renderBlocksToXlsx(parseMarkdown(""));
    expect(rt.richText).toEqual([{ text: "" }]);
  });
});
