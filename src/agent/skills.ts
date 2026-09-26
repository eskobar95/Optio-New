/**
 * Selective skill budget for `runAgentLoop`.
 *
 * Reads installed bodies from `.cursor/skills/<id>/SKILL.md` and
 * `.cursor/agents/<id>.md`. Does not copy skills anywhere else.
 *
 * Activation for one turn (also described in AGENTS.md):
 * 1. Load `bot-session` unless `skillBudget.allowedIds` omits it.
 * 2. Add other Kit Collective skills and specialists only when the prompt
 *    shares an id token, or a word of 4+ characters, with that file's
 *    frontmatter description. Highest score first. Bodies are not scanned.
 * 3. Load `caveman` only when `caveman: true` or the prompt contains
 *    `/caveman` and not `/caveman off`. Other `caveman-*` skills stay out.
 * 4. Stop at `maxSkills` (default 4) and `maxExcerptChars` (default 2000,
 *    shared by every excerpt this turn).
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface LoadedSkill {
  id: string;
  excerpt: string;
  source: "skill" | "specialist";
}

export interface SkillResolveInput {
  prompt: string;
  /** Opt-in. Default off. `/caveman off` in the prompt wins. */
  caveman?: boolean;
}

export interface SkillBudget {
  /** When set, ids outside this list are not loaded. */
  allowedIds?: readonly string[];
  maxSkills: number;
  /** Shared character cap for all excerpts this turn. */
  maxExcerptChars: number;
}

export const DEFAULT_SKILL_BUDGET: SkillBudget = {
  maxSkills: 4,
  maxExcerptChars: 2000,
};

export interface SkillLoader {
  resolve(input: SkillResolveInput, budget: SkillBudget): Promise<LoadedSkill[]>;
}

interface CatalogEntry {
  id: string;
  description: string;
  source: "skill" | "specialist";
  absolutePath: string;
}

const STOPWORDS = new Set([
  "and",
  "are",
  "for",
  "from",
  "into",
  "new",
  "not",
  "optio",
  "that",
  "the",
  "this",
  "use",
  "when",
  "with",
  "you",
  "your",
]);

const ELLIPSIS = "\n…";

export function createInstalledSkillLoader(options?: { root?: string }): SkillLoader {
  return {
    async resolve(input, budget) {
      const root = options?.root ?? process.cwd();
      const catalog = await loadCatalog(root);
      const chosen = selectEntries(catalog, input, budget);
      return readExcerpts(chosen, budget.maxExcerptChars);
    },
  };
}

export function cavemanRequested(input: SkillResolveInput): boolean {
  if (/\/caveman\s+off\b/i.test(input.prompt) || /\bcaveman\s+off\b/i.test(input.prompt)) {
    return false;
  }
  if (input.caveman === true) return true;
  return /\/caveman\b/i.test(input.prompt);
}

function selectEntries(
  catalog: CatalogEntry[],
  input: SkillResolveInput,
  budget: SkillBudget,
): CatalogEntry[] {
  const allowed = budget.allowedIds ? new Set(budget.allowedIds) : null;
  const permit = (id: string) => allowed === null || allowed.has(id);
  const pins: CatalogEntry[] = [];

  const botSession = catalog.find(
    (entry) => entry.source === "skill" && entry.id === "bot-session",
  );
  if (botSession && permit(botSession.id)) pins.push(botSession);

  if (cavemanRequested(input)) {
    const caveman = catalog.find((entry) => entry.source === "skill" && entry.id === "caveman");
    if (caveman && permit(caveman.id)) pins.push(caveman);
  }

  const promptTokens = significantTokens(input.prompt);
  const pinned = new Set(pins.map((entry) => entry.id));
  const ranked = catalog
    .filter((entry) => !pinned.has(entry.id) && !isCavemanFamily(entry.id) && permit(entry.id))
    .map((entry) => ({ entry, score: scoreEntry(entry, promptTokens) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  const room = Math.max(budget.maxSkills - pins.length, 0);
  return [...pins, ...ranked.slice(0, room).map((row) => row.entry)].slice(0, budget.maxSkills);
}

function scoreEntry(entry: CatalogEntry, promptTokens: string[]): number {
  const parts = new Set(entry.id.split("-").filter((part) => part.length >= 3));
  parts.add(entry.id);
  const description = tokens(entry.description);
  let score = 0;
  for (const token of promptTokens) {
    if (parts.has(token)) score += 3;
    else if (
      token.length >= 4 &&
      description.some((word) => word === token || word.startsWith(token))
    ) {
      score += 1;
    }
  }
  return score;
}

function isCavemanFamily(id: string): boolean {
  return id === "caveman" || id.startsWith("caveman-");
}

function significantTokens(text: string): string[] {
  return tokens(text).filter((token) => !STOPWORDS.has(token));
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
}

async function readExcerpts(
  entries: CatalogEntry[],
  maxExcerptChars: number,
): Promise<LoadedSkill[]> {
  const loaded: LoadedSkill[] = [];
  let remaining = maxExcerptChars;
  for (const entry of entries) {
    const excerpt = takeExcerpt(await readFile(entry.absolutePath, "utf8"), remaining);
    if (excerpt === null) break;
    remaining -= excerpt.length;
    loaded.push({ id: entry.id, excerpt, source: entry.source });
  }
  return loaded;
}

function takeExcerpt(raw: string, remaining: number): string | null {
  if (remaining <= ELLIPSIS.length) return null;
  if (raw.length <= remaining) return raw;
  return raw.slice(0, remaining - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}

async function loadCatalog(root: string): Promise<CatalogEntry[]> {
  const skillsDir = path.join(root, ".cursor", "skills");
  const agentsDir = path.join(root, ".cursor", "agents");
  const entries: CatalogEntry[] = [];

  const skillDirs = await readdir(skillsDir, { withFileTypes: true });
  for (const dir of skillDirs) {
    if (!dir.isDirectory()) continue;
    const absolutePath = path.join(skillsDir, dir.name, "SKILL.md");
    let markdown: string;
    try {
      markdown = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    const meta = parseFrontmatter(markdown);
    entries.push({
      id: meta.name || dir.name,
      description: meta.description,
      source: "skill",
      absolutePath,
    });
  }

  const agents = await readdir(agentsDir, { withFileTypes: true });
  for (const file of agents) {
    if (!file.isFile() || !file.name.endsWith(".md")) continue;
    const absolutePath = path.join(agentsDir, file.name);
    const markdown = await readFile(absolutePath, "utf8");
    const meta = parseFrontmatter(markdown);
    entries.push({
      id: meta.name || file.name.replace(/\.md$/, ""),
      description: meta.description,
      source: "specialist",
      absolutePath,
    });
  }

  return entries;
}

function parseFrontmatter(markdown: string): { name?: string; description: string } {
  if (!markdown.startsWith("---\n")) return { description: "" };
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return { description: "" };
  const raw = markdown.slice(4, end);
  return {
    name: readField(raw, "name"),
    description: readField(raw, "description") ?? "",
  };
}

function readField(raw: string, key: string): string | undefined {
  const lines = raw.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) return undefined;
  const rest = lines[index].slice(key.length + 1).trim();
  if (rest && rest !== ">" && rest !== "|" && rest !== ">-" && rest !== "|-") {
    return rest.replace(/^["']|["']$/g, "");
  }
  const folded: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    if (!/^\s/.test(lines[i])) break;
    folded.push(lines[i].trim());
  }
  return folded.join(" ");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
