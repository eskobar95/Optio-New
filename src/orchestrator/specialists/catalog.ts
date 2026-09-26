/**
 * Specialist folder allow-lists plus the implementation step's workflow list.
 * Bodies stay in `.cursor/agents`; these files only name tools and skills.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SPECIALIST_IDS = [
  "specialists/front-end",
  "specialists/back-end",
  "specialists/devops",
  "specialists/database",
] as const;

export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export interface SpecialistRecord {
  id: SpecialistId;
  cursorNativePath: string;
  responsibility: string;
  tools: readonly string[];
  skills: readonly string[];
  instructions: string;
}

export interface SpecialistCatalog {
  implementationAllowed: readonly SpecialistId[];
  get(id: string): SpecialistRecord | undefined;
}

const IndexSchema = z.object({
  specialists: z.array(
    z.object({
      id: z.string(),
      cursor_native_path: z.string().min(1),
      cursor_native_id: z.string().min(1),
      responsibility: z.string().min(1),
    }),
  ),
});

const AllowListSchema = z.object({
  id: z.string(),
  tools: z.array(z.string().min(1)).min(1),
  skills: z.array(z.string().min(1)),
});

export function repoRootFromHere(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../../", moduleUrl));
}

export function implementationSpecialistsAllowed(yaml: string): SpecialistId[] {
  const lines = yaml.split(/\r?\n/);
  let inStep = false;
  let inList = false;
  const ids: SpecialistId[] = [];
  for (const line of lines) {
    if (/^\s{2}- id: implementation\s*(#.*)?$/.test(line)) {
      inStep = true;
      inList = false;
      continue;
    }
    if (inStep && /^\s{2}- id: /.test(line)) break;
    if (!inStep) continue;
    if (/^\s{4}specialists_allowed:\s*\[\]\s*(#.*)?$/.test(line)) return [];
    if (/^\s{4}specialists_allowed:\s*(#.*)?$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const item = line.match(/^\s{6}- (specialists\/[A-Za-z0-9._-]+)\s*(#.*)?$/);
    if (item?.[1] && isSpecialistId(item[1])) {
      ids.push(item[1]);
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    inList = false;
  }
  return ids;
}

export function isSpecialistId(id: string): id is SpecialistId {
  return (SPECIALIST_IDS as readonly string[]).includes(id);
}

export async function loadSpecialistCatalog(root = repoRootFromHere()): Promise<SpecialistCatalog> {
  const index = IndexSchema.parse(
    JSON.parse(await readFile(path.join(root, "specialists", "index.json"), "utf8")),
  );
  const ids = index.specialists.map((entry) => entry.id);
  if (ids.join("\n") !== SPECIALIST_IDS.join("\n")) {
    throw new Error(`specialists/index.json must list ${SPECIALIST_IDS.join(", ")} in that order`);
  }

  const workflow = await readFile(path.join(root, "workflows", "default-task.yaml"), "utf8");
  const implementationAllowed = implementationSpecialistsAllowed(workflow);
  if (implementationAllowed.join("\n") !== SPECIALIST_IDS.join("\n")) {
    throw new Error("implementation specialists_allowed must match the specialist index");
  }

  const records = new Map<SpecialistId, SpecialistRecord>();
  for (const entry of index.specialists) {
    if (!isSpecialistId(entry.id)) {
      throw new Error(`unknown specialist id ${entry.id}`);
    }
    const folder = entry.id.slice("specialists/".length);
    const allow = AllowListSchema.parse(
      JSON.parse(await readFile(path.join(root, "specialists", folder, "allow-list.json"), "utf8")),
    );
    if (allow.id !== entry.id) {
      throw new Error(`${folder}/allow-list.json id must be ${entry.id}`);
    }
    const markdown = await readFile(path.join(root, entry.cursor_native_path), "utf8");
    records.set(entry.id, {
      id: entry.id,
      cursorNativePath: entry.cursor_native_path,
      responsibility: entry.responsibility,
      tools: allow.tools,
      skills: allow.skills,
      instructions: stripFrontmatter(markdown),
    });
  }

  return {
    implementationAllowed,
    get(id) {
      return isSpecialistId(id) ? records.get(id) : undefined;
    },
  };
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown.trim();
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown.trim();
  return markdown.slice(end + 4).trim();
}
