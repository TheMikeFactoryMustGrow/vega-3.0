/**
 * YAML Frontmatter Parser (US-012)
 *
 * Extracts YAML frontmatter from Obsidian markdown files and converts it to
 * structured objects. Handles all Lingelpedia template types: Entity, Account,
 * Investment (Deal & Personal Position), Cash Flow, Person, Institution, Vehicle.
 *
 * Usage:
 *   import { parseNoteFile, parseNoteString, extractWikilinks } from "../src/frontmatter-parser.js";
 *
 *   const note = await parseNoteFile("/path/to/note.md");
 *   console.log(note.frontmatter.type); // "entity"
 *   console.log(note.wikilinks);        // ["Mike Lingle", "Chase"]
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

// ── Types ────────────────────────────────────────────────────────────────────

export type TemplateType =
  | "entity"
  | "account"
  | "investment"
  | "cash-flow"
  | "person"
  | "institution"
  | "vehicle";

export type InvestmentPerspective = "deal" | "personal";

export type TruthScore =
  | "verified"
  | "agent-populated"
  | "stale"
  | "conflicted"
  | "unscored";

/** Common Lingelpedia fields present on all structured notes. */
export interface LingelpediaFields {
  is_canonical?: boolean;
  truth_score?: TruthScore;
  last_verified?: string;
  verification_source?: string;
}

/** The result of parsing a single Obsidian note. */
export interface ParsedNote {
  /** All frontmatter fields as a generic record. */
  frontmatter: Record<string, unknown> & LingelpediaFields;
  /** The template type derived from frontmatter.type. Null if unrecognized or absent. */
  templateType: TemplateType | null;
  /** For investment notes, the perspective (deal or personal). Null for other types. */
  investmentPerspective: InvestmentPerspective | null;
  /** The markdown body text (everything after the closing ---). */
  body: string;
  /** All [[wikilinks]] extracted from the body text. */
  bodyWikilinks: string[];
  /** All [[wikilinks]] extracted from frontmatter values. */
  frontmatterWikilinks: string[];
  /** Combined unique wikilinks from both frontmatter and body. */
  allWikilinks: string[];
  /** The source file path, if parsed from a file. */
  filePath: string | null;
}

// ── Wikilink Extraction ──────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Extract all [[wikilinks]] from a string. Handles aliases: [[Target|Display]].
 * Returns unique link targets (not display names).
 */
export function extractWikilinks(text: string): string[] {
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const target = match[1].trim();
    if (target) links.add(target);
  }
  return [...links];
}

// ── Frontmatter Extraction ───────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Split raw markdown content into frontmatter YAML string and body text.
 * Returns null for yamlString if no frontmatter block found.
 */
function splitFrontmatter(content: string): {
  yamlString: string | null;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { yamlString: null, body: content };
  }
  const yamlString = match[1];
  const body = content.slice(match[0].length).replace(/^\r?\n/, "");
  return { yamlString, body };
}

// ── YAML Parsing ─────────────────────────────────────────────────────────────

const VALID_TEMPLATE_TYPES = new Set<TemplateType>([
  "entity",
  "account",
  "investment",
  "cash-flow",
  "person",
  "institution",
  "vehicle",
]);

/**
 * Parse a YAML string into a frontmatter record.
 * Handles missing/malformed YAML gracefully — returns an empty record on failure.
 */
function parseFrontmatterYaml(
  yamlString: string
): Record<string, unknown> & LingelpediaFields {
  try {
    const parsed = parseYaml(yamlString, { prettyErrors: true });
    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, unknown> & LingelpediaFields;
  } catch {
    return {};
  }
}

/**
 * Extract wikilinks from all string values in a frontmatter object (recursively).
 */
function extractFrontmatterWikilinks(
  obj: unknown,
  links: Set<string> = new Set()
): string[] {
  if (typeof obj === "string") {
    for (const link of extractWikilinks(obj)) {
      links.add(link);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      extractFrontmatterWikilinks(item, links);
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj)) {
      extractFrontmatterWikilinks(value, links);
    }
  }
  return [...links];
}

// ── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Parse an Obsidian note from its raw markdown string.
 */
export function parseNoteString(
  content: string,
  filePath: string | null = null
): ParsedNote {
  const { yamlString, body } = splitFrontmatter(content);

  const frontmatter = yamlString
    ? parseFrontmatterYaml(yamlString)
    : ({} as Record<string, unknown> & LingelpediaFields);

  const typeRaw =
    typeof frontmatter["type"] === "string"
      ? (frontmatter["type"] as string).toLowerCase().trim()
      : null;

  const templateType =
    typeRaw !== null && VALID_TEMPLATE_TYPES.has(typeRaw as TemplateType)
      ? (typeRaw as TemplateType)
      : null;

  let investmentPerspective: InvestmentPerspective | null = null;
  if (templateType === "investment") {
    const perspRaw = frontmatter["perspective"];
    if (perspRaw === "deal" || perspRaw === "personal") {
      investmentPerspective = perspRaw;
    }
  }

  const bodyWikilinks = extractWikilinks(body);
  const frontmatterWikilinks = extractFrontmatterWikilinks(frontmatter);
  const allSet = new Set([...bodyWikilinks, ...frontmatterWikilinks]);

  return {
    frontmatter,
    templateType,
    investmentPerspective,
    body,
    bodyWikilinks,
    frontmatterWikilinks,
    allWikilinks: [...allSet],
    filePath,
  };
}

/**
 * Parse an Obsidian note from a file path.
 */
export async function parseNoteFile(filePath: string): Promise<ParsedNote> {
  const content = await readFile(filePath, "utf-8");
  return parseNoteString(content, filePath);
}
