/**
 * Append-only skill-pick feedback log (ENG-25 gate #3 → ENG-24 `optio.skill_pick_logs`).
 * In-memory store for tests/local; inject a DB-backed store in workers.
 */

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

/** Process-local ring for unit tests and smoke paths (no DB). */
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
