/**
 * Append-only skill-pick feedback log (ENG-25 gate #3 → ENG-24 `optio.skill_pick_logs`).
 * In-memory for tests; Drizzle writer for workers.
 */

import type { OptioDb } from "../../db/client.js";
import { skillPickLogs } from "../../db/schema/optio/transcripts.js";

export interface SkillPickLogRecord {
  workspaceId: string;
  taskId?: string;
  taskType?: string;
  agentId?: string;
  selectedSkillIds: string[];
  /** `selected` | `passthrough` | `error` (or free-form outcome text). */
  outcome: string;
}

export interface SkillPickLogStore {
  append(record: SkillPickLogRecord): Promise<void>;
}

export interface InMemorySkillPickLogStore extends SkillPickLogStore {
  readonly entries: readonly SkillPickLogRecord[];
  clear(): void;
}

/** Process-local store for unit tests and smoke paths (no DB). */
export function createInMemorySkillPickLogStore(): InMemorySkillPickLogStore {
  const entries: SkillPickLogRecord[] = [];
  return {
    get entries() {
      return entries;
    },
    clear() {
      entries.length = 0;
    },
    async append(record: SkillPickLogRecord): Promise<void> {
      entries.push({
        workspaceId: record.workspaceId,
        ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
        ...(record.taskType !== undefined ? { taskType: record.taskType } : {}),
        ...(record.agentId !== undefined ? { agentId: record.agentId } : {}),
        selectedSkillIds: [...record.selectedSkillIds],
        outcome: record.outcome,
      });
    },
  };
}

/** Persist picks into `optio.skill_pick_logs` via Drizzle. */
export function createDrizzleSkillPickLogStore(db: OptioDb): SkillPickLogStore {
  return {
    async append(record: SkillPickLogRecord): Promise<void> {
      await db.run((tx) =>
        tx.insert(skillPickLogs).values({
          workspaceId: record.workspaceId,
          taskId: record.taskId,
          taskType: record.taskType,
          agentId: record.agentId,
          selectedSkillIds: record.selectedSkillIds,
          outcome: record.outcome,
        }),
      );
    },
  };
}
