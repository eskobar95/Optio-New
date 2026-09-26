import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryStepCursorStore,
  RepoCatalogError,
  RepoWorktreeRouter,
  UnknownRepoError,
  loadRepoCatalog,
  matchRepoId,
  readWorkflowRepoId,
  resolveRepo,
  runPipeline,
  selectRepoId,
  type RepoCatalog,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(): Promise<{ repoPath: string; root: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "optio-repo-"));
  cleanups.push(dir);
  const repoPath = path.join(dir, "repo");
  const root = path.join(dir, "worktrees");
  await git(dir, ["init", "-b", "development", repoPath]);
  await git(repoPath, ["config", "user.email", "optio-new@example.com"]);
  await git(repoPath, ["config", "user.name", "Optio New"]);
  await git(repoPath, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "src", "keep.txt"), "keep\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "init"]);
  return { repoPath, root };
}

function catalogFor(
  alpha: { repoPath: string; root: string },
  beta: { repoPath: string; root: string },
): RepoCatalog {
  return {
    defaultRepoId: "alpha",
    repos: [
      {
        repoId: "alpha",
        cloneUrl: "https://example.com/alpha.git",
        localPath: alpha.repoPath,
        defaultBranch: "development",
        worktreeRoot: alpha.root,
      },
      {
        repoId: "beta",
        cloneUrl: "https://example.com/beta.git",
        localPath: beta.repoPath,
        defaultBranch: "development",
        worktreeRoot: beta.root,
      },
    ],
  };
}

describe("repo catalog", () => {
  it("uses one default checkout when OPTIO_NEW_REPOS is empty", () => {
    const catalog = loadRepoCatalog({});
    expect(resolveRepo(catalog).repoId).toBe("default");
    expect(resolveRepo(catalog).localPath).toBe("/opt/optio-new");
    expect(resolveRepo(catalog).worktreeRoot).toBe("/var/lib/optio-new/worktrees");
    expect(resolveRepo(catalog).defaultBranch).toBe("development");
  });

  it("maps repoId to path, remote, and branch and rejects an unknown id", () => {
    const catalog = loadRepoCatalog({
      OPTIO_NEW_DEFAULT_REPO_ID: "alpha",
      OPTIO_NEW_REPOS: JSON.stringify([
        {
          repoId: "alpha",
          cloneUrl: "https://example.com/alpha.git",
          localPath: "/repos/alpha",
          defaultBranch: "development",
          worktreeRoot: "/wt/alpha",
        },
        {
          repoId: "beta",
          cloneUrl: "https://example.com/beta.git",
          localPath: "/repos/beta",
          defaultBranch: "main",
          worktreeRoot: "/wt/beta",
        },
      ]),
    });
    expect(selectRepoId({ catalog })).toBe("alpha");
    expect(selectRepoId({ catalog, workflowRepoId: "beta" })).toBe("beta");
    expect(selectRepoId({ catalog, requested: "alpha", workflowRepoId: "beta" })).toBe("alpha");
    expect(resolveRepo(catalog, "beta")).toMatchObject({
      localPath: "/repos/beta",
      defaultBranch: "main",
      worktreeRoot: "/wt/beta",
      cloneUrl: "https://example.com/beta.git",
    });
    expect(() => resolveRepo(catalog, "missing")).toThrow(UnknownRepoError);
  });

  it("does not echo a secret when OPTIO_NEW_REPOS is not JSON", () => {
    const secret = "ghp_supersecrettoken";
    expect(() => loadRepoCatalog({ OPTIO_NEW_REPOS: secret })).toThrow(RepoCatalogError);
    try {
      loadRepoCatalog({ OPTIO_NEW_REPOS: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(RepoCatalogError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("reads workflow repo_id and leaves the default workflow unset", async () => {
    const workflow = await readFile("workflows/default-task.yaml", "utf8");
    expect(readWorkflowRepoId(workflow)).toBeUndefined();
    expect(readWorkflowRepoId("name: sample\nrepo_id: satellite\nsteps: []\n")).toBe("satellite");
  });

  it("matches a GitHub clone URL and refuses an unmatched repo when several are configured", () => {
    const catalog = loadRepoCatalog({
      OPTIO_NEW_REPOS: JSON.stringify([
        {
          repoId: "optio-new",
          cloneUrl: "https://github.com/eskobar95/Optio-New.git",
          localPath: "/opt/optio-new",
          defaultBranch: "development",
          worktreeRoot: "/wt/optio-new",
        },
        {
          repoId: "workplace",
          cloneUrl: "https://github.com/KitCollective/workplace.git",
          localPath: "/opt/workplace",
          defaultBranch: "main",
          worktreeRoot: "/wt/workplace",
        },
      ]),
    });
    expect(
      matchRepoId(catalog, {
        fullName: "KitCollective/workplace",
        cloneUrl: "https://github.com/KitCollective/workplace.git",
      }),
    ).toBe("workplace");
    expect(() => matchRepoId(catalog, { fullName: "other/repo" })).toThrow(UnknownRepoError);
    expect(matchRepoId(loadRepoCatalog({}), { fullName: "other/repo" })).toBe("default");
  });
});

describe("worktree router", () => {
  it("creates each task under the root for its repoId", async () => {
    const alpha = await initRepo();
    const beta = await initRepo();
    const router = new RepoWorktreeRouter({ catalog: catalogFor(alpha, beta) });

    const onAlpha = await router.create("task-a");
    const onBeta = await router.create("task-a", { repoId: "beta" });

    expect(onAlpha.path.startsWith(alpha.root + path.sep)).toBe(true);
    expect(onBeta.path.startsWith(beta.root + path.sep)).toBe(true);
    expect(onAlpha.path).not.toBe(onBeta.path);
    await expect(readFile(path.join(onBeta.path, "src", "keep.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );

    await router.reap("task-a", { merged: true });
    await expect(router.status("task-a")).resolves.toMatchObject({ path: onBeta.path });
    await router.reap("task-a", { merged: true });
    await expect(router.status("task-a")).resolves.toBeUndefined();
  });

  it("passes repoId from the stage job into worktree create", async () => {
    const seen: Array<string | undefined> = [];
    await runPipeline(
      { taskId: "t-1", sessionId: "s-1", repoId: "beta" },
      {
        cursors: new InMemoryStepCursorStore(),
        handler: { async run() {} },
        worktrees: {
          async create(taskId, options) {
            seen.push(options?.repoId);
            return {
              taskId,
              worktreeId: `wt-${taskId}`,
              path: `/tmp/${taskId}`,
              branch: `task/${taskId}`,
            };
          },
          async reap(taskId) {
            return { taskId, action: "reaped", path: "/tmp", reason: "merged" };
          },
        },
      },
    );
    expect(seen).toEqual(["beta"]);
  });
});
