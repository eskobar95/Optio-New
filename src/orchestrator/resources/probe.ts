/**
 * Host disk and memory probe. Walks to an existing ancestor so a worktree
 * root that does not exist yet is measured on the filesystem that would hold it.
 */
import { access } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { freemem } from "node:os";
import path from "node:path";
import type { MemorySample, ResourceProbe, ResourceSample } from "./guard.js";

async function existingAncestor(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export async function readDiskSample(targetPath: string): Promise<ResourceSample> {
  const probed = await existingAncestor(targetPath);
  const stats = await statfs(probed);
  return {
    path: targetPath,
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    freeInodes: Number(stats.ffree),
  };
}

export async function readAvailableMemoryBytes(): Promise<number> {
  try {
    const text = await readFile("/proc/meminfo", "utf8");
    const match = text.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match?.[1]) return Number(match[1]) * 1024;
  } catch {
    // Non-Linux hosts report via os.freemem.
  }
  return freemem();
}

export function createHostResourceProbe(): ResourceProbe {
  return {
    disk: (targetPath) => readDiskSample(targetPath),
    async memory(): Promise<MemorySample> {
      return { availableBytes: await readAvailableMemoryBytes() };
    },
  };
}
