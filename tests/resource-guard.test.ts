import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryTaskStatusStore,
  RepoWorktreeRouter,
  ResourceGuard,
  ResourceGuardError,
  loadRepoCatalog,
  loadResourceThresholds,
  type ResourceProbe,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function probe(samples: {
  worktreeFree?: number;
  dockerFree?: number;
  inodes?: number;
  memory?: number;
}): ResourceProbe {
  return {
    async disk(targetPath) {
      const docker = targetPath.includes("docker");
      return {
        path: targetPath,
        freeBytes: docker ? (samples.dockerFree ?? 5_000) : (samples.worktreeFree ?? 5_000),
        freeInodes: samples.inodes ?? 50_000,
      };
    },
    async memory() {
      return { availableBytes: samples.memory ?? 9_000_000 };
    },
  };
}

describe("ResourceGuard", () => {
  const thresholds = {
    minFreeDiskBytes: 1000,
    minFreeInodes: 100,
    minAvailableMemoryBytes: 500,
  };

  it("blocks worktree create and records a ResourceGuard task status", async () => {
    const status = new InMemoryTaskStatusStore();
    const guard = new ResourceGuard({
      thresholds,
      dockerDataRoot: "/var/lib/docker",
      status,
      probe: probe({ worktreeFree: 10, inodes: 500, memory: 9_000 }),
    });
    await expect(
      guard.assertCanCreate({ taskId: "t-disk", worktreeRoot: "/var/lib/optio-new/worktrees" }),
    ).rejects.toBeInstanceOf(ResourceGuardError);
    const record = await status.get("t-disk");
    expect(record).toMatchObject({ status: "blocked", code: "resource_guard" });
    expect(record?.message).toContain("ResourceGuard:");
    expect(record?.message).toContain("worktree root");
    expect(record?.message).not.toMatch(/ghp_|sk-|sha256=/);

    const dockerGuard = new ResourceGuard({
      thresholds,
      dockerDataRoot: "/var/lib/docker",
      status,
      probe: probe({ worktreeFree: 5_000, dockerFree: 1, inodes: 500, memory: 9_000 }),
    });
    await expect(
      dockerGuard.assertCanCreate({ taskId: "t-docker", worktreeRoot: "/wt" }),
    ).rejects.toThrow(/Docker data root/);

    const memoryGuard = new ResourceGuard({
      thresholds,
      dockerDataRoot: "/var/lib/docker",
      status,
      probe: probe({ worktreeFree: 5_000, dockerFree: 5_000, inodes: 500, memory: 10 }),
    });
    await expect(
      memoryGuard.assertCanCreate({ taskId: "t-mem", worktreeRoot: "/wt" }),
    ).rejects.toThrow(/available memory/);
  });

  it("does not create a worktree when the guard fails, and clears when the check passes", async () => {
    const status = new InMemoryTaskStatusStore();
    const guard = new ResourceGuard({
      thresholds,
      dockerDataRoot: "/var/lib/docker",
      status,
      probe: probe({ worktreeFree: 1 }),
    });
    let created = 0;
    const router = new RepoWorktreeRouter({
      catalog: loadRepoCatalog({}),
      guard,
      createManager() {
        return {
          async create(taskId: string) {
            created += 1;
            return { taskId, worktreeId: "wt", path: "/tmp/wt", branch: "task/t" };
          },
          async reap(taskId: string) {
            return {
              taskId,
              action: "reaped" as const,
              path: "/tmp/wt",
              reason: "merged" as const,
            };
          },
        };
      },
    });
    await expect(router.create("t-block")).rejects.toBeInstanceOf(ResourceGuardError);
    expect(created).toBe(0);
    expect(await status.get("t-block")).toMatchObject({ status: "blocked" });

    const open = new ResourceGuard({
      thresholds,
      dockerDataRoot: "/var/lib/docker",
      status,
      probe: probe({}),
    });
    await open.assertCanCreate({ taskId: "t-block", worktreeRoot: "/wt" });
    expect(await status.get("t-block")).toMatchObject({ status: "clear", message: "" });
  });

  it("reads thresholds from env and rejects a non-integer", () => {
    expect(
      loadResourceThresholds({
        OPTIO_NEW_MIN_FREE_DISK_BYTES: "42",
        OPTIO_NEW_MIN_FREE_INODES: "7",
        OPTIO_NEW_MIN_AVAILABLE_MEMORY_BYTES: "9",
      }),
    ).toEqual({
      minFreeDiskBytes: 42,
      minFreeInodes: 7,
      minAvailableMemoryBytes: 9,
    });
    expect(() => loadResourceThresholds({ OPTIO_NEW_MIN_FREE_DISK_BYTES: "lots" })).toThrow(
      /OPTIO_NEW_MIN_FREE_DISK_BYTES/,
    );
  });
});

describe("resource-usage script", () => {
  it("reports usage without secrets and exits non-zero when under the threshold", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "optio-usage-"));
    cleanups.push(dir);
    const worktree = path.join(dir, "worktrees");
    const docker = path.join(dir, "docker");
    await mkdir(worktree);
    await mkdir(docker);
    const secret = "super-secret-slack-value";
    const token = "ghp_supersecrettoken";
    const env = {
      ...process.env,
      OPTIO_NEW_WORKTREE_ROOT: worktree,
      OPTIO_NEW_DOCKER_DATA_ROOT: docker,
      OPTIO_NEW_MIN_FREE_DISK_BYTES: "1",
      OPTIO_NEW_MIN_FREE_INODES: "1",
      OPTIO_NEW_MIN_AVAILABLE_MEMORY_BYTES: "1",
      OPTIO_NEW_SLACK_SIGNING_SECRET: secret,
      OPTIO_NEW_GITHUB_TOKEN: token,
    };
    const ok = await execFileAsync("bash", ["scripts/resource-usage.sh"], { env });
    expect(ok.stdout).toContain("status=ok");
    expect(ok.stdout).toContain(`worktree_root=${worktree}`);
    expect(ok.stdout).toContain(`docker_data_root=${docker}`);
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(secret);
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(token);

    try {
      await execFileAsync("bash", ["scripts/resource-usage.sh"], {
        env: { ...env, OPTIO_NEW_MIN_FREE_DISK_BYTES: "999999999999999999" },
      });
      throw new Error("expected the script to exit non-zero");
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      expect(failed.stdout).toContain("status=blocked");
      expect(`${failed.stdout ?? ""}${failed.stderr ?? ""}`).not.toContain(secret);
      expect(`${failed.stdout ?? ""}${failed.stderr ?? ""}`).not.toContain(token);
    }
  });
});
