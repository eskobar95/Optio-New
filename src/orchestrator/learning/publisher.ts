/**
 * Files a meta-issue on GitHub when explicitly enabled.
 * A disabled publisher stores the draft only.
 */
import type { MetaIssueDraft } from "./template.js";

export interface MetaIssuePublishResult {
  filed: boolean;
  url: string | null;
}

export interface MetaIssuePublisher {
  publish(draft: MetaIssueDraft): Promise<MetaIssuePublishResult>;
}

export function createDisabledMetaIssuePublisher(): MetaIssuePublisher {
  return {
    async publish() {
      return { filed: false, url: null };
    },
  };
}

export function createGithubMetaIssuePublisher(options: {
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): MetaIssuePublisher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/issues`;

  return {
    async publish(draft) {
      const response = await postIssue(fetchImpl, endpoint, options.token, draft, true);
      const settled =
        response.status === 422
          ? await postIssue(fetchImpl, endpoint, options.token, draft, false)
          : response;
      if (!settled.ok) {
        throw new Error(`github meta-issue failed: ${settled.status}`);
      }
      const payload = (await settled.json()) as { html_url?: unknown };
      if (typeof payload.html_url !== "string" || payload.html_url.length === 0) {
        throw new Error("github meta-issue response missing html_url");
      }
      return { filed: true, url: payload.html_url };
    },
  };
}

export function createMetaIssuePublisherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MetaIssuePublisher {
  const enabled = env.OPTIO_LEARN_FILE_GITHUB === "1" || env.OPTIO_LEARN_FILE_GITHUB === "true";
  const token = env.OPTIO_NEW_GITHUB_TOKEN?.trim() ?? "";
  const repoSpec = env.OPTIO_LEARN_GITHUB_REPO?.trim() ?? "";
  const slash = repoSpec.indexOf("/");
  if (!enabled || !token || slash <= 0 || slash === repoSpec.length - 1) {
    return createDisabledMetaIssuePublisher();
  }
  return createGithubMetaIssuePublisher({
    token,
    owner: repoSpec.slice(0, slash),
    repo: repoSpec.slice(slash + 1),
  });
}

async function postIssue(
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string,
  draft: MetaIssueDraft,
  withLabel: boolean,
): Promise<Response> {
  const payload: { title: string; body: string; labels?: string[] } = {
    title: draft.title,
    body: draft.body,
  };
  if (withLabel) payload.labels = [...draft.labels];
  return fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "optio-new-learning-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });
}
