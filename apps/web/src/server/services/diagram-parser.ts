import { type DiagramFormat, type DiagramContentType } from "@prisma/client";
import {
  callClaude,
  callClaudeWithImage,
  parseJsonResponse,
  type VisionMediaType,
} from "./ai/router";
import {
  DIAGRAM_ANALYSIS_SYSTEM_PROMPT,
  buildDiagramAnalysisPrompt,
} from "./ai/prompts/diagram-analysis";

// ─── Types ──────────────────────────────────────────────────────

export interface DiagramEntity {
  name: string;
  type: string;
  technology?: string;
  description?: string;
}

export interface DiagramConnection {
  from: string;
  to: string;
  protocol?: string;
  description?: string;
  direction?: "unidirectional" | "bidirectional";
}

export interface DiagramDatastore {
  name: string;
  type: string;
  connectedTo: string[];
}

export interface DiagramExternalSystem {
  name: string;
  type: string;
  connectedTo: string[];
}

export interface DiagramBoundary {
  name: string;
  contains: string[];
}

export interface ExtractedDiagramEntities {
  diagramType: string;
  entities: {
    components: DiagramEntity[];
    connections: DiagramConnection[];
    datastores: DiagramDatastore[];
    externalSystems: DiagramExternalSystem[];
    boundaries: DiagramBoundary[];
  };
}

export interface DiagramParseResult {
  format: DiagramFormat;
  diagramType: DiagramContentType;
  title: string;
  summary: string;
  extractedEntities: ExtractedDiagramEntities;
  sourceCode: string | null;
}

// ─── Format Detection ────────────────────────────────────────────

const FORMAT_SIGNATURES: Record<string, DiagramFormat> = {
  "workspace": "STRUCTURIZR",
  "model": "STRUCTURIZR",
  "@startuml": "PLANTUML",
  "@startmindmap": "PLANTUML",
  "@startsalt": "PLANTUML",
  "@startditaa": "PLANTUML",
  "@startgantt": "PLANTUML",
  "participant": "WEBSEQUENCEDIAGRAMS",
};

/**
 * Detect diagram format from file extension and content.
 */
export function detectDiagramFormat(
  filename: string,
  mimeType: string,
  contentSample?: string
): DiagramFormat {
  const ext = filename.toLowerCase().split(".").pop();

  // File extension-based detection
  switch (ext) {
    case "mmd":
    case "mermaid":
      return "MERMAID";
    case "puml":
    case "plantuml":
    case "pu":
      return "PLANTUML";
    case "dsl":
      return "STRUCTURIZR";
    case "wsd":
      return "WEBSEQUENCEDIAGRAMS";
    case "svg":
      return "SVG";
    case "png":
      return "PNG";
    case "jpg":
    case "jpeg":
      return "JPEG";
    case "drawio":
      return "DRAW_IO";
  }

  // MIME type detection
  if (mimeType === "image/svg+xml") return "SVG";
  if (mimeType === "image/png") return "PNG";
  if (mimeType === "image/jpeg") return "JPEG";

  // Content-based detection for text files
  if (contentSample) {
    const trimmed = contentSample.trim();

    for (const [signature, format] of Object.entries(FORMAT_SIGNATURES)) {
      if (trimmed.startsWith(signature)) return format;
    }

    // Mermaid detection: common diagram type keywords at the start
    const mermaidKeywords = [
      "graph", "flowchart", "sequenceDiagram", "classDiagram",
      "stateDiagram", "erDiagram", "gantt", "pie", "gitGraph",
      "C4Context", "C4Container", "C4Component", "C4Deployment",
    ];
    if (mermaidKeywords.some((kw) => trimmed.startsWith(kw))) {
      return "MERMAID";
    }
  }

  return "OTHER";
}

/**
 * Check if the diagram format is text-based (has parseable source code).
 */
export function isTextBasedDiagram(format: DiagramFormat): boolean {
  return ["STRUCTURIZR", "MERMAID", "PLANTUML", "WEBSEQUENCEDIAGRAMS"].includes(format);
}

/**
 * Check if the diagram format is a raster/vector image (requires vision AI).
 */
export function isImageDiagram(format: DiagramFormat): boolean {
  return ["PNG", "JPEG", "SVG"].includes(format);
}

// ─── Parsing ────────────────────────────────────────────────────

/**
 * Parse a text-based diagram source and extract entities using a combination
 * of format-specific parsing and AI analysis.
 */
export async function parseTextDiagram(
  sourceCode: string,
  format: DiagramFormat,
  assessmentContext?: string
): Promise<DiagramParseResult> {
  const aiResult = await callClaude({
    system: DIAGRAM_ANALYSIS_SYSTEM_PROMPT,
    userContent: buildDiagramAnalysisPrompt({
      sourceCode,
      format,
      isImage: false,
      assessmentContext,
    }),
    parseResult: (raw) =>
      parseJsonResponse<{
        title: string;
        summary: string;
        diagramType: string;
        extractedEntities: ExtractedDiagramEntities;
      }>(raw),
  });

  return {
    format,
    diagramType: mapDiagramType(aiResult.result.diagramType),
    title: aiResult.result.title,
    summary: aiResult.result.summary,
    extractedEntities: aiResult.result.extractedEntities,
    sourceCode,
  };
}

/**
 * Parse an image-based diagram (PNG, JPEG, SVG) using Claude's vision capability.
 * The image is sent as base64 to extract entities and generate a description.
 */
export async function parseImageDiagram(
  imageBuffer: Buffer,
  mimeType: string,
  filename: string,
  assessmentContext?: string
): Promise<DiagramParseResult> {
  // SVG can't go through the Anthropic vision API — it's XML. Send it as
  // text and let Claude reason over the markup directly. Everything else
  // (PNG/JPEG/WEBP/GIF) goes through vision.
  const isSvg = mimeType === "image/svg+xml" || filename.toLowerCase().endsWith(".svg");

  const parse = (raw: string) =>
    parseJsonResponse<{
      title: string;
      summary: string;
      diagramType: string;
      extractedEntities: ExtractedDiagramEntities;
    }>(raw);

  if (isSvg) {
    const svgText = imageBuffer.toString("utf8");
    const aiResult = await callClaude({
      system: DIAGRAM_ANALYSIS_SYSTEM_PROMPT,
      userContent: buildDiagramAnalysisPrompt({
        sourceCode: svgText,
        format: "SVG",
        isImage: false,
        assessmentContext,
      }),
      parseResult: parse,
    });
    return {
      format: "SVG",
      diagramType: mapDiagramType(aiResult.result.diagramType),
      title: aiResult.result.title,
      summary: aiResult.result.summary,
      extractedEntities: aiResult.result.extractedEntities,
      sourceCode: svgText,
    };
  }

  const mediaType: VisionMediaType =
    mimeType === "image/jpeg" || filename.toLowerCase().match(/\.(jpe?g)$/)
      ? "image/jpeg"
      : mimeType === "image/webp"
        ? "image/webp"
        : mimeType === "image/gif"
          ? "image/gif"
          : "image/png";

  const aiResult = await callClaudeWithImage({
    system: DIAGRAM_ANALYSIS_SYSTEM_PROMPT,
    text: buildDiagramAnalysisPrompt({
      format: mediaType,
      isImage: true,
      assessmentContext,
    }),
    imageBase64: imageBuffer.toString("base64"),
    imageMediaType: mediaType,
    parseResult: parse,
  });

  const format: DiagramFormat =
    mediaType === "image/jpeg" ? "JPEG" : "PNG";

  return {
    format,
    diagramType: mapDiagramType(aiResult.result.diagramType),
    title: aiResult.result.title,
    summary: aiResult.result.summary,
    extractedEntities: aiResult.result.extractedEntities,
    sourceCode: null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function mapDiagramType(raw: string): DiagramContentType {
  const mapping: Record<string, DiagramContentType> = {
    system_context: "SYSTEM_CONTEXT",
    container: "CONTAINER",
    component: "COMPONENT",
    deployment: "DEPLOYMENT",
    sequence: "SEQUENCE",
    data_flow: "DATA_FLOW",
    network_topology: "NETWORK_TOPOLOGY",
    er_diagram: "ER_DIAGRAM",
    state_machine: "STATE_MACHINE",
    activity_flow: "ACTIVITY_FLOW",
    infrastructure: "INFRASTRUCTURE",
  };
  return mapping[raw.toLowerCase()] ?? "OTHER";
}
