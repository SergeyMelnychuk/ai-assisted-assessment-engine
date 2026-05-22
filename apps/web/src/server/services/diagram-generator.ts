import { type DiagramFormat, type DiagramContentType } from "@prisma/client";
import { callClaude } from "./ai/router";
import {
  DIAGRAM_GENERATION_SYSTEM_PROMPT,
  buildDiagramGenerationPrompt,
} from "./ai/prompts/diagram-generation";

// ─── Types ──────────────────────────────────────────────────────

export interface DiagramGenerationRequest {
  /** What type of diagram to generate */
  diagramType: DiagramContentType;
  /** Output format — Mermaid for MVP, PlantUML for MVP+1 */
  outputFormat: DiagramFormat;
  /** Natural-language description of what the diagram should show */
  description: string;
  /** Assessment context: components, services, findings, etc. */
  assessmentContext: string;
  /** Optional: entities extracted from uploaded diagrams to include */
  existingEntities?: string;
  /** Title for the diagram */
  title: string;
}

export interface DiagramGenerationResult {
  sourceCode: string;
  format: DiagramFormat;
  diagramType: DiagramContentType;
  title: string;
  description: string;
}

// ─── Generation ─────────────────────────────────────────────────

/**
 * Generate a text-based architecture diagram from assessment data.
 * Uses Claude to produce Mermaid or PlantUML source code.
 */
export async function generateDiagram(
  request: DiagramGenerationRequest
): Promise<DiagramGenerationResult> {
  const aiResult = await callClaude({
    system: DIAGRAM_GENERATION_SYSTEM_PROMPT,
    userContent: buildDiagramGenerationPrompt({
      diagramType: request.diagramType,
      outputFormat: request.outputFormat,
      description: request.description,
      assessmentContext: request.assessmentContext,
      existingEntities: request.existingEntities,
      title: request.title,
    }),
    parseResult: (raw) => {
      // Extract the diagram source code from the response.
      // Claude may wrap it in a code fence — strip it.
      const fenceMatch = raw.match(/```(?:mermaid|plantuml|puml)?\n([\s\S]*?)```/);
      if (fenceMatch) return fenceMatch[1].trim();
      return raw.trim();
    },
    maxTokens: 4096,
  });

  return {
    sourceCode: aiResult.result,
    format: request.outputFormat,
    diagramType: request.diagramType,
    title: request.title,
    description: request.description,
  };
}

/**
 * Generate the set of diagrams appropriate for an assessment's deliverables.
 * Returns a list of generation requests based on assessment mode and available data.
 */
export function planDiagramsForDeliverable(opts: {
  assessmentMode: string;
  activeDomains: string[];
  hasArchitectureData: boolean;
  hasInfrastructureData: boolean;
  hasDataFlowData: boolean;
  hasSequenceFlowData: boolean;
}): DiagramGenerationRequest[] {
  const diagrams: DiagramGenerationRequest[] = [];

  // Current-state system context (for existing system / modernization)
  if (
    opts.hasArchitectureData &&
    ["EXISTING_SYSTEM", "MODERNIZATION", "AUDIT"].includes(opts.assessmentMode)
  ) {
    diagrams.push({
      diagramType: "SYSTEM_CONTEXT",
      outputFormat: "MERMAID",
      description: "Current-state system context showing major components and external dependencies",
      assessmentContext: "", // filled by caller
      title: "Current-State System Context",
    });
  }

  // Target-state architecture direction
  if (opts.hasArchitectureData) {
    diagrams.push({
      diagramType: "CONTAINER",
      outputFormat: "MERMAID",
      description: "Target-state architecture direction showing proposed components and their interactions",
      assessmentContext: "",
      title: "Target-State Architecture Direction",
    });
  }

  // Deployment topology
  if (opts.hasInfrastructureData && opts.activeDomains.includes("cloud_infrastructure")) {
    diagrams.push({
      diagramType: "DEPLOYMENT",
      outputFormat: "MERMAID",
      description: "Deployment topology showing infrastructure components, environments, and hosting",
      assessmentContext: "",
      title: "Deployment Topology",
    });
  }

  // Data flow diagram
  if (opts.hasDataFlowData && opts.activeDomains.includes("data_distribution")) {
    diagrams.push({
      diagramType: "DATA_FLOW",
      outputFormat: "MERMAID",
      description: "Data flow diagram showing how data moves between systems and services",
      assessmentContext: "",
      title: "Data Flow Overview",
    });
  }

  // Sequence diagram for critical flows
  if (opts.hasSequenceFlowData) {
    diagrams.push({
      diagramType: "SEQUENCE",
      outputFormat: "MERMAID",
      description: "Sequence diagram for the most critical identified user/system flow",
      assessmentContext: "",
      title: "Critical Flow Sequence",
    });
  }

  // Greenfield capability map
  if (opts.assessmentMode === "GREENFIELD") {
    diagrams.push({
      diagramType: "SYSTEM_CONTEXT",
      outputFormat: "MERMAID",
      description: "Proposed system context for the new product, showing capabilities and external integrations",
      assessmentContext: "",
      title: "Proposed System Context",
    });
  }

  return diagrams;
}

// ─── Rendering ──────────────────────────────────────────────────

/**
 * Render a Mermaid diagram source to SVG/PNG using @mermaid-js/mermaid-cli.
 * Returns the path where the rendered image was saved.
 *
 * Note: Requires `mmdc` (mermaid-cli) to be installed.
 * In Docker, this runs via puppeteer in headless Chrome.
 */
export async function renderMermaidToImage(
  sourceCode: string,
  outputFormat: "svg" | "png" = "svg"
): Promise<{ imagePath: string; svgContent?: string }> {
  // Implementation uses child_process to call mmdc.
  // Writes source to a temp file, runs mmdc, reads the output.
  const { writeFile, readFile, mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const tempDir = await mkdtemp(join(tmpdir(), "mermaid-"));
  const inputPath = join(tempDir, "input.mmd");
  const outputPath = join(tempDir, `output.${outputFormat}`);

  try {
    await writeFile(inputPath, sourceCode, "utf-8");

    await execFileAsync("mmdc", [
      "-i", inputPath,
      "-o", outputPath,
      "-b", "transparent",
      ...(outputFormat === "png" ? ["-s", "2"] : []),
    ]);

    const svgContent = outputFormat === "svg"
      ? await readFile(outputPath, "utf-8")
      : undefined;

    return { imagePath: outputPath, svgContent };
  } catch (error) {
    // Clean up on failure
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Failed to render Mermaid diagram: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Render a PlantUML diagram source to SVG/PNG using a PlantUML server.
 * Expects a PlantUML server running (e.g., via docker-compose).
 */
export async function renderPlantUMLToImage(
  sourceCode: string,
  outputFormat: "svg" | "png" = "svg"
): Promise<{ imagePath: string; svgContent?: string }> {
  const serverUrl = process.env.PLANTUML_SERVER_URL ?? "http://localhost:8080";

  // PlantUML server accepts POST with the source and returns the rendered image.
  const endpoint = outputFormat === "svg" ? "/svg" : "/png";

  const response = await fetch(`${serverUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: sourceCode,
  });

  if (!response.ok) {
    throw new Error(`PlantUML render failed: ${response.status} ${response.statusText}`);
  }

  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const tempDir = await mkdtemp(join(tmpdir(), "plantuml-"));
  const outputPath = join(tempDir, `output.${outputFormat}`);

  if (outputFormat === "svg") {
    const svgContent = await response.text();
    await writeFile(outputPath, svgContent, "utf-8");
    return { imagePath: outputPath, svgContent };
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(outputPath, buffer);
    return { imagePath: outputPath };
  }
}
