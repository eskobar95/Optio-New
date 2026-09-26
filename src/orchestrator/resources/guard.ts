/**
 * Disk, inode, and memory checks before a worktree is created.
 * Below a threshold: record a ResourceGuard task status and fail closed.
 */
import { z } from "zod";

export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MIN_FREE_INODES = 10_000;
export const DEFAULT_MIN_AVAILABLE_MEMORY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_DOCKER_DATA_ROOT = "/var/lib/docker";

export interface ResourceThresholds {
  minFreeDiskBytes: number;
  minFreeInodes: number;
  minAvailableMemoryBytes: number;
}

export const DEFAULT_RESOURCE_THRESHOLDS: ResourceThresholds = {
  minFreeDiskBytes: DEFAULT_MIN_FREE_DISK_BYTES,
  minFreeInodes: DEFAULT_MIN_FREE_INODES,
  minAvailableMemoryBytes: DEFAULT_MIN_AVAILABLE_MEMORY_BYTES,
};

export interface ResourceSample {
  path: string;
  freeBytes: number;
  freeInodes: number;
}

export interface MemorySample {
  availableBytes: number;
}

export interface ResourceProbe {
  disk(targetPath: string): Promise<ResourceSample>;
  memory(): Promise<MemorySample>;
}

export interface TaskStatusRecord {
  taskId: string;
  status: "blocked" | "clear";
  code: "resource_guard";
  message: string;
}

export interface TaskStatusStore {
  record(entry: TaskStatusRecord): Promise<void>;
  get(taskId: string): Promise<TaskStatusRecord | undefined>;
}

export class InMemoryTaskStatusStore implements TaskStatusStore {
  private readonly rows = new Map<string, TaskStatusRecord>();

  async record(entry: TaskStatusRecord): Promise<void> {
    this.rows.set(entry.taskId, { ...entry });
  }

  async get(taskId: string): Promise<TaskStatusRecord | undefined> {
    const found = this.rows.get(taskId);
    return found ? { ...found } : undefined;
  }
}

export class ResourceGuardError extends Error {
  readonly code = "resource_guard" as const;
  readonly taskStatus: TaskStatusRecord;

  constructor(taskStatus: TaskStatusRecord) {
    super(taskStatus.message);
    this.name = "ResourceGuardError";
    this.taskStatus = taskStatus;
  }
}

function readCount(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return Number(raw.trim());
}

export function loadResourceThresholds(env: NodeJS.ProcessEnv = process.env): ResourceThresholds {
  return {
    minFreeDiskBytes: readCount(env, "OPTIO_NEW_MIN_FREE_DISK_BYTES", DEFAULT_MIN_FREE_DISK_BYTES),
    minFreeInodes: readCount(env, "OPTIO_NEW_MIN_FREE_INODES", DEFAULT_MIN_FREE_INODES),
    minAvailableMemoryBytes: readCount(
      env,
      "OPTIO_NEW_MIN_AVAILABLE_MEMORY_BYTES",
      DEFAULT_MIN_AVAILABLE_MEMORY_BYTES,
    ),
  };
}

export function readDockerDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPTIO_NEW_DOCKER_DATA_ROOT?.trim();
  return raw || DEFAULT_DOCKER_DATA_ROOT;
}

const ThresholdSchema = z.object({
  minFreeDiskBytes: z.number().int().nonnegative(),
  minFreeInodes: z.number().int().nonnegative(),
  minAvailableMemoryBytes: z.number().int().nonnegative(),
});

export interface ResourceGuardOptions {
  thresholds: ResourceThresholds;
  dockerDataRoot: string;
  probe: ResourceProbe;
  status?: TaskStatusStore;
}

export class ResourceGuard {
  readonly thresholds: ResourceThresholds;
  readonly dockerDataRoot: string;
  readonly status: TaskStatusStore;
  private readonly probe: ResourceProbe;

  constructor(options: ResourceGuardOptions) {
    this.thresholds = ThresholdSchema.parse(options.thresholds);
    this.dockerDataRoot = options.dockerDataRoot.trim() || DEFAULT_DOCKER_DATA_ROOT;
    this.probe = options.probe;
    this.status = options.status ?? new InMemoryTaskStatusStore();
  }

  /** Fail closed before `git worktree add`. A clear status means the check passed. */
  async assertCanCreate(input: { taskId: string; worktreeRoot: string }): Promise<void> {
    const failure = await this.firstFailure(input.worktreeRoot);
    if (failure) {
      const record: TaskStatusRecord = {
        taskId: input.taskId,
        status: "blocked",
        code: "resource_guard",
        message: failure,
      };
      await this.status.record(record);
      throw new ResourceGuardError(record);
    }
    await this.status.record({
      taskId: input.taskId,
      status: "clear",
      code: "resource_guard",
      message: "",
    });
  }

  private async firstFailure(worktreeRoot: string): Promise<string | undefined> {
    const worktree = await this.readDisk(worktreeRoot);
    const disk = this.diskFailure("worktree root", worktree);
    if (disk) return disk;
    const docker = await this.readDisk(this.dockerDataRoot);
    const dockerFailure = this.diskFailure("Docker data root", docker);
    if (dockerFailure) return dockerFailure;
    let memory: MemorySample;
    try {
      memory = await this.probe.memory();
    } catch {
      return "ResourceGuard: cannot read available memory";
    }
    if (memory.availableBytes < this.thresholds.minAvailableMemoryBytes) {
      return `ResourceGuard: available memory is ${memory.availableBytes} bytes; threshold is ${this.thresholds.minAvailableMemoryBytes} bytes`;
    }
    return undefined;
  }

  private async readDisk(targetPath: string): Promise<ResourceSample> {
    try {
      return await this.probe.disk(targetPath);
    } catch {
      return { path: targetPath, freeBytes: -1, freeInodes: -1 };
    }
  }

  private diskFailure(label: string, sample: ResourceSample): string | undefined {
    if (sample.freeBytes < 0 || sample.freeInodes < 0) {
      return `ResourceGuard: cannot read free disk under ${label} ${sample.path}`;
    }
    if (sample.freeBytes < this.thresholds.minFreeDiskBytes) {
      return `ResourceGuard: free disk under ${label} ${sample.path} is ${sample.freeBytes} bytes; threshold is ${this.thresholds.minFreeDiskBytes} bytes`;
    }
    if (sample.freeInodes < this.thresholds.minFreeInodes) {
      return `ResourceGuard: free inodes under ${label} ${sample.path} is ${sample.freeInodes}; threshold is ${this.thresholds.minFreeInodes}`;
    }
    return undefined;
  }
}
