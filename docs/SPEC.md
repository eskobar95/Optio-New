# Agent Harness Skeleton — Specification

**Status:** Draft for review (pre-implementation)  
**Goal:** Self-hosted coding agent factory driven by New Bot (decision layer) and BullMQ (pipeline), built on Vercel Eve patterns, with selective skill loading, git worktree isolation, Jev on the decision hot path, and self-improvement from failure fingerprints.  
**Non-goals (v1):** Replacing the coding LLM; multi-tenant SaaS; Temporal/CrewAI/AutoGen; Inngest; Vercel Workflows/WDK (or any Vercel-hosted workflow orchestration); Cursor RPC MITM / Cursor-through-proxy; auto-merging without human/CI gates.

---

## 1. Design principles

1. **Filesystem is the authoring interface** — agents, specialists, and skills are directories and markdown/TypeScript files, not hidden config in a database.
2. **Cursor-native is the single source of truth** — skills and specialist agents under **this repo’s** `.cursor/skills` and `.cursor/agents` are canonical for Optio-New; staging copies under `harness/staging/` and `specs/harness-working-skills/` are historical snapshots only (see §6.5).
3. **Orchestrator owns lifecycle; Eve owns the agent loop** — workflows, worktrees, New Bot sessions, and budgets live in the harness; Eve subagents do implementation work.
4. **Load only what the step needs** — skills and specialists are referenced and loaded on demand; never dump the whole library into context at implementation start.
5. **Jev decides; the coding model writes** — routing, tool-gates, and completion checks go to Jev; code and long reasoning stay with the frontier coding model.
6. **BullMQ owns the pipeline** — Redis + BullMQ is the official orchestrator for the full issue-to-merge job graph; stages wait on prior completion and resume after crashes (see §14.0).
7. **Self-learning with human review** — the system proposes skill/budget changes via New Bot meta-tasks (chat/API); it does not silently rewrite production gates.

---

## 2. Top-level folder structure

Sibling top-level folders (not nested under a single “agents only” tree):

```text
harness/
├── agents/                 # Workflow-phase agents (Eve roots / session agents)
│   ├── planner/
│   ├── implementation/
│   ├── review/
│   ├── ready/
│   └── merge/
├── specialists/            # Thin refs/indexes → Cursor-native subagents (§6.5); no body copies
│   └── (id → path map / Eve load stubs)
├── skills/                 # Thin refs/indexes → Cursor-native skills (§6.5); no body copies
│   └── (id → path map)
├── workflows/              # Step graphs, gates, skill budgets per step
│   └── default-task.yaml
├── orchestrator/           # New Bot intake, job queue, worktree mgr, Jev client, OTel
│   ├── intake/
│   ├── jobs/
│   ├── worktrees/
│   ├── jev/
│   ├── learning/
│   └── telemetry/          # OTel helpers, canonical span names
├── adapters/               # CodingAgent backends (model-agnostic)
│   ├── cursor/             # Cursor CLI headless (subscription only in v1)
│   └── codex/              # Codex CLI → local gateway
├── gateway/                # LiteLLM + JevRouter plugins
│   ├── litellm/
│   └── jev-router/
├── state/                  # Runtime DB schemas / migrations (Postgres)
└── docs/
    └── SPEC.md             # This document
```

Each **agent** and **specialist** directory follows Eve’s filesystem shape:

```text
agents/implementation/
├── agent.ts                # model, tool policy, budget hooks
├── instructions.md         # always-on prompt; references specialists + skills by id
├── tools/                  # optional typed tools for this agent only
└── (no local skills/ copy — skills live in shared skills/)

specialists/front-end/
├── agent.ts
├── instructions.md
└── tools/
```

Shared skills:

```text
skills/coding/react-patterns.md
skills/review/pr-checklist.md
skills/git/worktree-hygiene.md
skills/meta/failure-fingerprint.md
```

**Rule:** `agents/` and harness-side specialist stubs may _reference_ skill/subagent ids; they must not vendor duplicate bodies. Canonical bodies live in the **Cursor-native project tree** (§6.5). Any `harness/skills/` or `harness/specialists/` paths in this tree are **thin index/refs** (ids → Cursor-native paths), not a second copy of content.

---

## 3. Workflows as step loops with gates

A **workflow** is an ordered graph of steps. Each step names:

- which **agent** runs
- which **specialists** may be called
- which **skills** are in the step’s **skill budget** (allow-list)
- **entry gates** (must pass before the agent starts)
- **exit gates** (must pass before advancing)
- **on-fail** branches (retry, escalate, replan, open meta-issue)

### 3.1 Default issue workflow

```text
[New Bot intake / task created]
        │
        ▼
   ┌─────────┐
   │ planner │  → produce plan + selected skill/specialist set
   └────┬────┘
        │ gate: plan_approved? (elicitation or auto if confidence high)
        ▼
┌─────────────────┐
│ implementation  │  → code in isolated worktree; may call specialists
└────────┬────────┘
         │ gate: tests_green? Jev completion? no open blockers?
         ▼
   ┌─────────┐
   │ review  │  → review agent (+ review skills only)
   └────┬────┘
        │ gate: review_pass? else → implementation (with review notes)
        ▼
   ┌───────┐
   │ ready │  → PR opened/updated; CI watched; status → ready (reported to New Bot)
   └────┬──┘
        │ gate: CI green + human/policy merge allow?
        ▼
   ┌───────┐
   │ merge │  → merge into development; then worktree cleanup
   └───────┘
```

### 3.2 Step definition (conceptual schema)

```yaml
# workflows/default-issue.yaml
name: default-issue
trigger: bot.intake.created
base_branch: development

steps:
  - id: planner
    agent: agents/planner
    skill_budget_mode: short_term   # see §6
    specialists_allowed: []
    skills_allowed: [skills/meta/*, skills/coding/task-decompose]
    entry_gates: [session_acked]
    exit_gates: [plan_present, jev_route_ok]
    on_fail: escalate_bot

  - id: implementation
    agent: agents/implementation
    skill_budget_mode: short_term   # later: orchestrator_restricted
    specialists_allowed:
      - specialists/front-end
      - specialists/back-end
      - specialists/devops
      - specialists/database
    skills_allowed: from_planner_selection   # intersected with global allow-list
    entry_gates: [worktree_ready, plan_approved]
    exit_gates: [jev_completion, local_checks]
    on_fail: retry_then_replan

  - id: review
    agent: agents/review
    specialists_allowed: []
    skills_allowed: [skills/review/*]
    entry_gates: [diff_present]
    exit_gates: [jev_review_pass]
    on_fail: return_to: implementation

  - id: ready
    agent: agents/ready
    skills_allowed: [skills/git/pr-hygiene]
    entry_gates: [review_pass]
    exit_gates: [pr_open, ci_pending_or_green]
    on_fail: escalate_bot

  - id: merge
    agent: agents/merge
    skills_allowed: [skills/git/merge-policy]
    entry_gates: [ci_green, merge_policy_allow]
    exit_gates: [merged_into_development]
    on_success: delete_worktree
```

### 3.3 If-else between agents

Branching is **orchestrator-owned**, not left to free-form chat:

| Condition                                         | Next step                                             |
| ------------------------------------------------- | ----------------------------------------------------- |
| Planner confidence low / ambiguous scope          | New Bot elicitation → wait → resume planner or cancel |
| Implementation exit fail (tests / Jev completion) | Retry implementation (budget N) then planner replan   |
| Review fail                                       | implementation with `review_notes` in session state   |
| CI fail after ready                               | implementation (debug) or escalate after N attempts   |
| Merge policy deny                                 | stay in ready; notify human                           |

Jev may **score/route** these branches; code enforces the transition table.

---

## 4. Agents as Eve subagents

- Each folder under `agents/` is an **Eve agent** (root for that workflow step).
- The orchestrator starts the correct Eve agent for the current step inside the issue’s worktree (or harness control plane for planner/merge as appropriate).
- Each agent has **`instructions.md`** that:
  - states its phase role (implement vs review vs merge)
  - **names** allowed specialists by path/id (does not embed their full prompts)
  - **names** skill ids it may `load_skill` (budget-constrained at runtime)
  - forbids loading skills outside the current step budget
- **Subagent calls:** when implementation needs deep FE work, it invokes `specialists/front-end` as an Eve subagent (fresh history, shared sandbox/worktree, no inherited review-only skills).

### 4.1 Example `agents/implementation/instructions.md` (contract)

- You implement the approved plan for the current task.
- Load skills only via `load_skill` and only if they appear in the active skill budget.
- Call specialists for niche work; do not impersonate review or merge.
- Prefer smallest diff; do not touch unrelated packages.
- On blocked external decision, escalate to New Bot / the human in chat — do not invent policy.

---

## 5. Specialists (niche coding agents)

| Specialist              | Responsibility                                     |
| ----------------------- | -------------------------------------------------- |
| `specialists/front-end` | UI, components, client state, a11y, styling        |
| `specialists/back-end`  | APIs, services, auth, server business logic        |
| `specialists/devops`    | CI, Docker, deploy manifests, observability wiring |
| `specialists/database`  | schema, migrations, queries, indexes               |

Rules:

- Canonical specialist/subagent **bodies** live in Cursor-native definitions (§6.5); harness `specialists/` holds refs/stubs only.
- Dynamically callable by agents that list them in `specialists_allowed` for the step.
- Each stub resolves to Cursor-native `instructions` + optional tools; they **share** skills via on-demand load from the same SoT.
- Specialists never advance the workflow graph; they return results to the calling agent. Only the orchestrator advances steps.

---

## 6. Skills library and skill-budget mechanism

### 6.1 Shared library (Cursor-native backed)

- Skill **bodies** live in the caller’s Cursor-native project definitions (see §6.5), not in a harness-owned duplicate tree on `development`.
- Harness `skills/` (if present) is an **id → path index** only.
- Usable by any agent or specialist subject to the **active budget**.
- Loaded **on demand** (`load_skill`) from that canonical source — never bulk-injected at session start.
- Skill metadata (frontmatter or sidecar JSON): `id`, `phase_tags` (`implementation` | `review` | `merge` | `meta`), `cost_hint`, `owner`, `source_path` (Cursor-native path).

### 6.2 Short-term budget (v1 default)

- Agent `instructions.md` lists candidate skill ids.
- Planner may further narrow the set for this issue (`from_planner_selection`).
- At runtime the agent may freely `load_skill` any skill in that intersection.
- Orchestrator still **blocks** loads outside the allow-list (hard gate, not a suggestion).

### 6.3 Long-term budget (orchestrator-restricted)

- Per workflow step, `skills_allowed` becomes the sole source of truth (planner selection is an input, not a bypass).
- Orchestrator injects `active_skill_budget: string[]` into session context every turn.
- Attempts to load outside budget → tool-gate deny (Jev optional; policy deny mandatory).

### 6.4 Self-learning budget shrinkage

1. Every skill load and outcome is logged (see §10).
2. If skill S is associated with repeated failures in a phase (threshold configurable, e.g. ≥3 failures / 14 days with low Jev/completion success), learning module opens a **meta-issue**: “Propose removing `skills/…` from `implementation` budget.”
3. On meta-issue approval (human), orchestrator updates `workflows/*.yaml` budgets (or a `budgets/overrides.json`).
4. **Never** auto-delete skill files in v1 — only remove from budgets; archive later.

### 6.5 Source of truth — Cursor-native definitions

The caller’s existing **Cursor project** already defines skills, subagents, commands, and rules in-repo (typically under `.cursor/` or the project’s equivalent). Those files are the **single source of truth**.

| Concern                   | Rule                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No harness copies**     | The harness must **not** duplicate or copy skills / subagents / commands / rules into a separate harness-owned tree on `development`. Parallel copies drift from what humans edit daily in Cursor.                                                                                                                                                                                  |
| **Reference, don’t fork** | Harness + Eve **reference** Cursor-native definitions directly (by path or by importing from the project’s existing `.cursor/` — or equivalent — directories). Eve loads skills and specialists **on demand** from that same source.                                                                                                                                                |
| **Worktree exclusion**    | Worktree spin-up must **explicitly exclude** (or otherwise not materialize as ambient context) Cursor-native skill / subagent / command / rule files into the isolated agent worktree. They are **not** part of the agent’s working context unless explicitly loaded by id through Eve. Coding CLIs must not auto-ingest the whole `.cursor/` library just because it sits on disk. |
| **Commands ↔ workflows**  | Cursor **commands** map conceptually to harness **workflows**: Cursor commands remain the **human-facing authoring surface**; harness workflows are the **runtime surface**. Both should point at the same underlying step definitions where possible (shared ids / shared YAML or markdown steps), not two divergent graphs.                                                       |
| **Rules vs skills**       | **Rules** are always-on context; **skills / subagents** are on-demand. Rules need different handling (e.g. a **minimal always-loaded subset** chosen by policy). That subset still comes from the **Cursor-native** rule source — never a harness-rewritten copy.                                                                                                                   |

**Authoring loop:** humans edit skills/subagents/commands/rules in Cursor as today → harness indexes those paths → Eve `load_skill` / specialist invoke resolves to the live file on the control-plane checkout (or a read-only mount of the SoT tree), not a worktree-local fork.

---

## 7. Worktree lifecycle

```text
New Bot task created / intake accepted
        → ensure branch: task/<TASK-ID>-slug from latest origin/development
        → git worktree add ../wt-<TASK-ID> task/<TASK-ID>-slug
        → install deps in worktree (cached where possible)
        → all implementation/review agent cwd = worktree
        → push branch; open/update PR into development
        → on PR merged into development (GitHub webhook)
              → verify merge commit on development
              → git worktree remove --force
              → delete local branch; optional remote cleanup
              → report task done to New Bot / comment cleanup complete
```

Rules:

- **One worktree per active task** (task id is the key).
- Base is always **latest `development`** at creation time; rebase/update policy is an exit-gate concern before ready/merge.
- Worktree is **not** deleted on PR open, CI fail, or review fail — only after **merged into development** (or explicit abort/cancel path that closes the issue without merge).
- Abort path: human cancels session → archive worktree path under `orphaned/` or remove after grace period; never leave anonymous dirs.
- **Cursor-native SoT exclusion:** when creating the worktree (or configuring the CodingAgent cwd), **exclude / sparse-omit** `.cursor/` skills, subagents, commands, and rules (and any mirrored harness index that would dump them into context). Agents receive only what Eve loads by id (§6.5).

---

## 8. Intake — New Bot decision layer (ADR)

> **ADR:** Linear product integration is **out of scope** for Optio-New v1.  
> **New Bot** (Grok Bot / Cursor agent) is the **control and decision plane**: it decides what to build, receives human feedback, and drives pipeline gates.  
> **BullMQ** remains the **pipeline orchestrator** (see §14.0). Do not build Linear webhooks, GraphQL, OAuth agent scopes, or Agent Sessions into this product.

**Primary trigger:** New Bot chat/API intake → enqueue BullMQ job (`bot.intake.created`).

**Requirements:**

- Accept a task payload (title, description, optional repo/branch hints) from New Bot.
- ACK fast and enqueue BullMQ work; do not block the chat turn on the full pipeline.
- Surface elicitations, progress, and failures back to New Bot / the human in chat.
- Optional later: HTTP intake webhook (Caddy `/webhooks/*`) for New Bot / CI with signature verification.

**Explicitly out (v1):**

- Linear Agent Session webhooks, Agent Activities, backlog polling, Linear status vocabulary (Backlog / Implementing / Ready as tracker states).
- Any requirement that Linear must exist for the factory to run.

**Auth (optional webhook):** shared secret / HMAC for intake; GitHub webhooks remain for PR/CI signals.

## 9. Jev AI — decision layer only

### 9.1 Principle

**Jev is the decision layer wherever there is a choice with uncertainty.** Hard rules — secrets handling, destructive ops, branch protection, webhook auth — stay in **deterministic code**. Jev may advise on soft tool-gates; it never overrides a hard deny.

### 9.2 Where Jev is used (overview)

Beyond the two routing hops in §14 (Hop 1 backend selection; Hop 2 Codex upstream/cache/deny), Jev applies at:

| #   | Decision point              | What Jev decides                                                                                                                                  |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Gate decisions**          | Review pass/fail; implementation completion; whether to send a run back for rework (vs escalate / replan)                                         |
| 2   | **Dynamic skill-budget**    | Score or select which skills to allow for this step from issue context + historical skill performance (intersected with workflow hard allow-list) |
| 3   | **Specialist selection**    | Which specialist to invoke given issue type/content (within `specialists_allowed`)                                                                |
| 4   | **Self-learning threshold** | Whether a failure-fingerprint pattern has crossed the bar to open a meta-issue (§10) — complements fixed counters                                 |
| 5   | **Concurrency / quota**     | Given quota snapshots and budgets, whether another CodingAgent run may start now (vs delay / queue)                                               |
| 6   | **Tool-gates (soft)**       | allow / confirm / deny for risky-but-not-hard-coded tools                                                                                         |
| 7   | **Workflow routing**        | Which next step when the transition table allows more than one branch                                                                             |

Proxy hops (already in §14) are part of the same decision layer, not a separate product.

### 9.3 Must not

Generate code; write PR bodies as the sole author; browse the web; replace the coding model; bypass hard security or branch-protection rules.

### 9.4 Integration

- Orchestrator calls Decision API / MCP (`jev_decide`, `jev_guard_tool_call`, etc.) with compact **state** assembled in code.
- Thresholds in config: high confidence → auto; low → New Bot elicitation.
- Shadow mode recommended before enforcing deny gates in production.
- Same `JevRouter` / Jev client abstraction used for Hop 1–2 can back gate, budget, specialist, threshold, and concurrency decisions — one decision surface, many call sites.

---

## 10. Self-improvement

### 10.1 Failure fingerprints

On each failed gate, failed CI, or escalated session, log:

```text
fingerprint = hash(
  workflow_id,
  step_id,
  skill_ids_loaded[],
  specialist_ids_used[],
  error_class,          # e.g. test_fail, jev_completion_low, merge_conflict
  repo_area_hint        # optional path prefix / package name
)
```

Store in Postgres with issue id, timestamps, raw excerpt (redacted).

### 10.2 Meta-issues

When a fingerprint (or skill id) crosses thresholds:

1. Create New Bot meta-task labeled `meta/self-improve`.
2. Body includes: pattern stats, proposed budget change or skill patch draft, links to sample issues.
3. Human (or designated meta-agent under review) approves.
4. Apply: budget override and/or PR against `skills/` or `workflows/`.

### 10.3 What v1 will not do

- Silent prompt mutation in production without a PR/meta-issue.
- Automatic removal of skills from disk.
- Using Jev as the coding model to “rewrite the harness.”

---

## 11. Runtime components (skeleton)

| Component           | Role                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| HTTP webhook server | New Bot intake + GitHub events; fast ACK                                                           |
| Job queue           | **BullMQ (Redis)** — official pipeline orchestrator (§14.0); not Inngest, not Vercel Workflows/WDK |
| Worktree manager    | create/status/remove; path registry                                                                |
| Eve runner          | start agent/specialist sessions in worktree                                                        |
| Jev client          | decisions with logging                                                                             |
| State DB            | sessions, budgets, fingerprints, step cursors                                                      |
| Learning worker     | aggregate fingerprints → meta-issues                                                               |

Suggested v1 stack: **Node/TypeScript**, Eve for agent loops, **CodingAgent adapters** (Cursor CLI headless + Codex CLI) for code mutation, on a Hetzner VPS. Compose/observability in §12; adapter contract in §13.

**Do not add a second agent framework in v1.** No CrewAI, AutoGen, Temporal, or LangGraph-as-orchestrator. Eve + BullMQ + this harness are enough.

---

## 12. Observability and VPS operations

### 12.1 Instrumentation foundation

Instrument the harness with **OpenTelemetry from day one**. One OTel SDK / collector path feeds both the agent UI and infra backends. Do not invent a parallel proprietary logging format for agent events — emit spans (and structured log records correlated by `trace_id`).

### 12.2 Agent live UI

| Option                          | Role                                                                                                       | When to use                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Langfuse** (self-hosted, MIT) | Primary live UI for agent runs, specialist calls, skill loads, Jev gate decisions, and multi-turn sessions | Default on a capable Hetzner box                                               |
| **Phoenix** (Arize, ELv2)       | Lighter single-container agent/LLM tracing and evals                                                       | If Langfuse’s ClickHouse + Postgres + Redis stack is too heavy for a small VPS |

Map custom harness spans into Langfuse observations (or OpenInference-compatible attributes for Phoenix). Prefer Langfuse sessions keyed by task_id / session id so operators can watch a single issue end-to-end.

### 12.3 Infra traces, logs, metrics

Pick **one** infra stack (not both at first):

- **SigNoz** (MIT) — unified OTLP traces + logs + metrics; good “one box” Datadog-style alternative.
- **Grafana Loki + Tempo + Prometheus** — if the team already knows Grafana; Tempo for traces, Loki for logs, Prometheus for metrics.

Route orchestrator, webhook, BullMQ worker, and host metrics here. Keep LLM/agent deep-dive in Langfuse (or Phoenix); keep disk, CPU, queue depth, webhook latency, and Postgres health in SigNoz/Grafana.

### 12.4 Canonical span names

Bake these span (or observation) names in from the start. Every span **must** carry attributes `task_id` and `worktree_id` (empty string only when not yet created / already removed):

| Span name         | Emitted when                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow.step`   | A workflow step starts / ends (planner, implementation, …)                                                                                                         |
| `agent.run`       | An Eve agent session runs for a step                                                                                                                               |
| `specialist.call` | A specialist subagent is invoked                                                                                                                                   |
| `skill.load`      | A skill is loaded into context                                                                                                                                     |
| `jev.decision`    | A Jev routing / tool-gate / completion / review decision                                                                                                           |
| `worktree.create` | Worktree created for an issue                                                                                                                                      |
| `worktree.remove` | Worktree deleted after merge (or abort cleanup)                                                                                                                    |
| `intake.webhook`  | Inbound New Bot / CI intake (or related) webhook handled                                                                                                           |
| `gate.pass`       | An entry/exit gate succeeds                                                                                                                                        |
| `gate.fail`       | An entry/exit gate fails                                                                                                                                           |
| `session.queue`   | A coding-session slot is granted, queued, rejected, released, or cancelled. Attribute `queue_depth` is the per-provider wait gauge (metric `session.queue_depth`). |

Recommended extra attributes (where applicable): `workflow_id`, `step_id`, `agent_id`, `specialist_id`, `skill_id`, `jev_question`, `gate_id`, `error_class`, `fingerprint`.

### 12.5 VPS must-haves (durable deployment)

| Concern             | Choice                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process supervision | **Docker Compose** with `restart: unless-stopped`, plus **systemd** unit to ensure Compose stack starts on boot                                                            |
| Public webhooks TLS | **Caddy** or **Traefik** terminating TLS for optional New Bot intake + GitHub webhook endpoints                                                                            |
| Secrets             | **sops + age** on the Hetzner kit-harness (`/opt/optio-new`); Infisical is an optional later swap. Never commit plaintext or production ciphertext. See `docs/secrets.md`. |
| Database backups    | **restic** or **borg** of Postgres dumps to a **Hetzner Storage Box** (scheduled)                                                                                          |
| Network hardening   | **Hetzner Cloud Firewall** + **fail2ban** on SSH                                                                                                                           |
| Logging format      | Structured **JSON** logs on stdout (scraped to Loki/SigNoz); correlate with `trace_id`                                                                                     |
| Worker health       | HTTP **health endpoints** for queue workers (liveness + optional queue lag)                                                                                                |
| Merge / CI signals  | **GitHub webhooks** (PR merged, check suite) in addition to New Bot status                                                                                                 |

The Hetzner boot unit (`deploy/systemd/optio-new-compose.service`) enables Compose profiles `harness` and `orchestrator` next to the default set (Redis, Postgres, LiteLLM). kit-harness is published on `127.0.0.1:3200` only. Profile `edge` stays off until `OPTIO_NEW_WEBHOOK_HOST` has DNS. After a merge to `main`, rebuild on the VPS with `scripts/vps-pull-rebuild.sh`. Runbook: `deploy/README.md`.

### 12.6 Practical v1 Compose stack

```text
Redis
Postgres
BullMQ workers (orchestrator)
Eve / agent runner
LiteLLM Proxy     # Codex gateway; default service set (no profile)
kit-harness       # profile harness; 127.0.0.1:3200
OTel Collector
Langfuse          # or Phoenix on small boxes
SigNoz            # or Grafana Loki (+ Tempo + Prometheus)
Caddy/Traefik
```

Optional later: Phoenix alongside Langfuse only if you need eval notebooks; do not duplicate agent UIs in v1.

### 12.7 Explicit non-goals for frameworks

Skip a second agent framework. **No CrewAI, no Temporal, no AutoGen, no Vercel Workflows/WDK, no Inngest in v1.** Durability comes from BullMQ job steps + Postgres session state + OTel traces — not from adding another orchestrator. Vercel is AI Gateway only (§14.0, §14.3).

---

## 13. Coding-model abstraction (model-agnostic backends)

The harness must treat the **coding LLM/CLI as a swappable backend**. Eve still owns session shape and skill loading policy; the **CodingAgent adapter** owns “write code in this worktree.” Cursor, Codex, and later providers are interchangeable behind one interface. Prompts for agents, specialists, and skills stay **provider-neutral** (no Claude-only or Codex-only syntax).

### 13.1 `CodingAgent` adapter interface

Thin interface implemented once per provider:

**Input**

- `worktree_path` — absolute path to the issue worktree (cwd for the run)
- `prompt` / `instructions` — task brief + active skill excerpts already resolved by the harness
- `allowed_tools` — harness policy (e.g. edit, shell, git, no network) mapped to provider capabilities
- `budget` — max tokens, max wall-clock, max tool rounds, optional USD cap
- `metadata` — `task_id`, `worktree_id`, `workflow_id`, `step_id`, `agent_id`, `model_id`

**Output**

- `branch` / remote ref used (usually the issue branch already checked out)
- `diff_summary` — files changed, optional unified diff or commit SHAs
- `pr_ready` — whether the adapter pushed / prepared a PR tip (orchestrator opens/updates PR)
- `logs` — structured run log path or stream handle
- `usage` — `{ input_tokens, output_tokens, cached_tokens?, cost_usd?, model_id, provider }`
- `status` — `succeeded` | `failed` | `cancelled` | `budget_exhausted` | `rate_limited`
- `error_class` — optional fingerprint-friendly class for §10

Adapters **must not** own workflow advancement, worktree create/delete, or intake webhooks. They only mutate the worktree and report.

### 13.2 First adapters: Cursor CLI and Codex CLI

| Adapter           | Backend                      | Selection                                       |
| ----------------- | ---------------------------- | ----------------------------------------------- |
| `adapters/cursor` | Cursor CLI **headless** mode | Config: global default and/or per workflow step |
| `adapters/codex`  | OpenAI **Codex CLI**         | Same                                            |

Selection order:

1. Step-level `coding_backend` in `workflows/*.yaml` if set
2. Else global `harness.config` default
3. Else fail closed (do not silently pick a provider)

Example:

```yaml
steps:
  - id: implementation
    agent: agents/implementation
    coding_backend: cursor # or codex
  - id: review
    agent: agents/review
    coding_backend: codex # optional: cheaper/faster model for review
```

Both adapters honor the same budget and tool allow-list; unsupported tools are denied by the harness before launch.

### 13.3 Model-agnostic prompts

- `instructions.md`, specialist prompts, and `skills/**/*.md` use **plain markdown** and harness vocabulary (`load_skill`, specialist ids, gate names).
- Forbidden in shared content: provider-specific tool XML, Claude/Codex-only slash commands, vendor system-prompt idioms, or “you are GPT/Claude” lock-in.
- Provider-specific glue (CLI flags, permission mode, MCP wiring) lives **only** inside the adapter package.
- When a skill must mention a tool, name the **harness capability** (`shell`, `edit_file`, `run_tests`), not a vendor tool string.

### 13.4 Per-run cost and token tracking

Every adapter run writes a usage row (Postgres) and an OTel span attribute set on `agent.run` / provider child span:

- `provider`, `model_id`
- `task_id`, `worktree_id`, `step_id`, `workflow_id`
- `input_tokens`, `output_tokens`, `cost_usd` (estimated if provider omits)

Budgets: soft warn in Langfuse/SigNoz; hard stop when step or daily USD/token caps hit (`budget_exhausted`). Aggregate dashboards by model, issue, and step for §10 learning and capacity planning.

### 13.5 Rate limits and concurrency per provider

| Control                  | Behavior                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| Per-provider concurrency | Semaphore in the orchestrator (e.g. max N Cursor, M Codex runs on the VPS) |
| Per-provider rate limit  | Token bucket / queue delay on 429; exponential backoff with jitter         |
| Fairness                 | Prefer older tasks when contending for slots                               |
| Isolation                | One coding-adapter process per worktree run; no shared cwd                 |

Exhausted quotas surface as `rate_limited` → BullMQ retry with delay or New Bot elicitation if SLA exceeded — not a silent hang.

The semaphore lives in `src/orchestrator/sessions` (`createSessionGate`). Caps: `OPTIO_NEW_CURSOR_MAX_CONCURRENCY` (N) and `OPTIO_NEW_CODEX_MAX_CONCURRENCY` (M). Overflow: `OPTIO_NEW_SESSION_OVERFLOW` = `queue` (oldest `enqueuedAt` first) or `reject` (`codingAgentStatus: rate_limited`, nothing queued). A granted session holds one `SessionWorkspacePort` claim. The worktree manager (SPEC §7) plugs in via `workspacePortFromWorktreeManager`; `release` drops the claim and does not reap. Queue depth is span `session.queue` plus gauge `session.queue_depth` (both carry `task_id` and `worktree_id`).

### 13.6 Practical VPS concerns for coding CLIs

| Concern                                | Requirement                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Git commit identity**                | Dedicated bot identity for agent commits (`user.name` / `user.email` in worktree or `GIT_AUTHOR_*`); never the human operator’s global git identity. Signed commits optional later (bot SSH/GPG).                                                                                                  |
| **Branch protection on `development`** | Protect `development`: no direct push from agents; only PR merge (human and/or required checks). Agents push only `issue/<id>-*` branches.                                                                                                                                                         |
| **Sandboxing CLI processes**           | Run Cursor/Codex under least privilege: worktree-scoped cwd, no Docker socket, restricted network if possible, resource limits (cgroup/Docker `--memory`/`--cpus`), secrets via env injected by orchestrator not readable repo-wide. Prefer container-per-run or dedicated OS user `agent-runner`. |
| **Binary/auth on host**                | Cursor CLI + Codex CLI installed on the VPS (or image); API keys only in sops/Infisical; never baked into worktrees.                                                                                                                                                                               |
| **Non-interactive**                    | Headless/non-TTY flags required; no interactive login prompts mid-job (pre-auth at deploy time).                                                                                                                                                                                                   |
| **Cleanup**                            | Kill adapter child processes on session stop / job cancel; scavenge orphans on worker start.                                                                                                                                                                                                       |

### 13.7 Relation to Eve

Eve agents/specialists decide _what_ to do (plan, load skills, call specialists). When a step needs code mutation, the orchestrator calls `CodingAgent.run(...)` with the active worktree. Review/merge steps may use a coding backend for analysis-only (read tools) or skip the adapter and use harness tools only — configured per step.

---

## 14. Proxy and routing architecture

The harness separates **backend choice** (which CodingAgent runs) from **upstream model choice** (which API a Codex-compatible path hits). Codex can sit behind a local gateway; Cursor CLI cannot in v1.

### 14.0 Pipeline orchestration (BullMQ) — architectural decision

**Decision:** **BullMQ (on Redis) is the official orchestrator** for the full task-to-merge pipeline: intake → planning → implementation → review → merge (and related side jobs such as learning/meta-issues).

**How it works**

- Each pipeline stage is a **BullMQ job** (or a chain/flow of jobs) that **waits for the previous stage to complete** before starting.
- Job payloads + Postgres session/step cursors make progress **durable**: if a worker or job **crashes, it resumes from where it left off** (idempotent handlers; no restart of the whole issue from scratch unless the step is marked failed and requeued).
- New Bot intake ACK fast and enqueue BullMQ work; Eve/CodingAgent runs are **invoked by workers**, not by a separate cloud workflow engine.

**Vercel scope (narrow)**

- **Vercel is used only for the AI Gateway** (temporary hosted path for the `jev` JevRouter plugin — §14.3).
- **Do not** use **Vercel Workflows**, the **Workflow Development Kit (WDK)**, or any Vercel-hosted workflow runner for this pipeline.
- Control-plane hosting stays on the self-hosted VPS Compose stack (orchestrator + BullMQ workers + Redis + Postgres). “Eve patterns” in this spec mean agent-loop shape, not Vercel Workflows product.

**Closed alternatives:** self-hosted Inngest, Temporal, CrewAI/AutoGen/LangGraph-as-orchestrator, and Vercel Workflows/WDK are **out** for v1 pipeline orchestration (see also §11, §12.7).

### 14.1 Asymmetry: Codex yes, Cursor no

| Client         | Custom model base URL?                                                                                                                                                               | v1 stance                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Codex CLI**  | Yes — `~/.codex/config.toml`: `openai_base_url` **or** `[model_providers.<id>]` with `base_url` + `env_key`, `wire_api = "responses"`                                                | Point at local LiteLLM (or thin pre-proxy) on `http://127.0.0.1:<port>/v1`                                 |
| **Cursor CLI** | No usable model proxy — `OPENAI_BASE_URL` / Azure env vars ignored; `--endpoint` / `CURSOR_API_ENDPOINT` only select Cursor’s auth/API host, then **private `agent.v1` Connect-RPC** | Leave on native subscription path (`CURSOR_API_KEY` → `api2.cursor.sh`). **Do not MITM Cursor RPC in v1.** |

Community “Cursor API proxies” usually wrap Cursor the _other_ way (expose Cursor as OpenAI for other clients). That is out of scope for routing our CLI through caller-owned models.

**Explicit non-goal:** Skip Cursor-through-proxy until Cursor ships a real custom model endpoint for the CLI.

### 14.2 Local gateway (LiteLLM)

Self-host **LiteLLM Proxy** on the VPS as the default gateway:

- `model_list` entries for: (a) subscription-backed / ChatGPT-compatible upstreams used when Codex is configured that way, (b) the caller’s own API keys (OpenAI, Anthropic via LiteLLM, OpenRouter, etc.), (c) optional semantic/exact **cache** backends.
- Codex `config.toml` (user-level / runner profile, **not** committed secrets) sets `openai_base_url` or a custom `model_providers.harness_gateway` → localhost.
- Add a **thin Node or FastAPI pre-proxy** in front of LiteLLM **only** if you need Responses-API translation from chat-only upstreams, or hooks LiteLLM cannot express cleanly.

Compose addition (conceptual): `litellm` (+ optional `harness-gateway` pre-proxy) beside Redis/Postgres/workers.

### 14.3 JevRouter as a swappable module

Implement **`JevRouter`** behind a small plugin interface so the decision engine is replaceable without touching CodingAgent adapters:

```text
interface JevRouter {
  decide(state: RoutingState): Promise<RoutingDecision>
}
// RoutingDecision.choice ∈ { subscription_pool, alt_api, cache, deny }
// Implementations: jev | poorjev | laya | rules
```

**v1 hosted-Jev path (temporary):** While TypeSafe has a **sign-up pause** and direct Jev API access is unavailable, the `jev` implementation’s **base URL points at [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)** (not TypeSafe’s direct hosted endpoint). Config-only — swap back to TypeSafe (or to self-hosted Laya/poorjev) without touching adapters when access reopens. **This is the only Vercel dependency in v1** — not workflow orchestration (§14.0).

Wire-up options (pick one primary):

- LiteLLM `custom_router` / `async_pre_call_hook` (or routing plugin) calling `JevRouter`
- Thin Node/FastAPI middleware calling `JevRouter` then forwarding to LiteLLM

Shared skills/agents never import a concrete Jev client — only the router module does.

### 14.4 Two Jev hops

```text
Orchestrator / CodingAgent
        │  Hop 1 — which backend?
        │  Jev Choice: cursor_subscription | codex_gateway | (future adapters)
        ▼
   Cursor CLI ─── native Cursor API (no local model MITM)
        or
   Codex CLI ─── localhost gateway
                    │  Hop 2 — which upstream? (Codex path only)
                    │  Jev Choice: subscription_pool | alt_api | cache | deny
                    ▼
                 LiteLLM (+ optional pre-proxy) → provider / cache
```

- **Hop 1** (orchestrator): respects quotas, cost budgets, step `coding_backend` overrides; fail closed if undecided.
- **Hop 2** (gateway, Codex-only runs): picks concrete model/upstream or serves cache; never runs for Cursor CLI traffic in v1.

### 14.5 Auth and header rewriting

| Path                | Auth rule                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex → gateway     | CLI sends **Bearer = local virtual key** (LiteLLM master/virtual key). Gateway **strips** it and injects **real upstream `Authorization`**.                                            |
| Cursor subscription | Native `CURSOR_API_KEY` → `api2.cursor.sh` only. No key rewrite in a local proxy.                                                                                                      |
| Secrets             | Real provider keys live in host sops+age ciphertext (Infisical only if adopted later) and gateway env — **never in the git worktree**, never in issue branches. See `docs/secrets.md`. |

### 14.6 Cache hit and deny

- **cache:** Gateway returns the stored completion (same shape Codex expects); emit OTel/Langfuse span attrs `route=cache`, zero or minimal upstream tokens.
- **deny:** Gateway responds **429** (or structured budget error); CodingAgent maps to `status: rate_limited` or `budget_exhausted` and BullMQ/New Bot handling from §13.

### 14.7 Folder / compose touchpoints

```text
adapters/
├── cursor/          # subscription only in v1
└── codex/           # configures openai_base_url → gateway
orchestrator/
└── routing/         # Hop-1 JevRouter + backend selection
gateway/
├── litellm/         # config.yaml model_list, hooks
└── jev-router/      # plugin impls: jev, poorjev, laya, rules
```

---

## 15. Acceptance criteria for the skeleton

1. New Bot enqueue (chat/API; optional webhook later) creates a session, worktree from `development`, and planner run.
2. Implementation context contains **only** budgeted skills; review skills are absent until the review step.
3. Specialists are invokable only when listed on the step.
4. PR merge into `development` deletes the worktree; earlier failures do not.
5. Jev is called for at least routing + completion; no Jev call is used to emit application source code.
6. Three repeated failures with the same fingerprint open a meta-issue with a concrete budget proposal.
7. A full issue run produces the canonical OTel spans (§12.4) visible in Langfuse (or Phoenix), tagged with `task_id` and `worktree_id`.
8. Infra health (workers, Redis, Postgres, webhook latency) is visible in SigNoz or Grafana; secrets are not in git; Postgres backup to Storage Box is scheduled.
9. The same implementation step can run via Cursor or Codex by flipping `coding_backend` only; shared skills/prompts need no edit.
10. Agent commits use the bot git identity; pushes never land directly on protected `development`.
11. Codex runs can target localhost LiteLLM via config; Cursor runs never depend on OPENAI_BASE_URL or RPC MITM.
12. JevRouter is swappable (jev / poorjev / laya / rules) without changing CodingAgent adapters; Hop 1 picks backend, Hop 2 (Codex only) picks upstream/cache/deny.
13. Skills/subagents/commands/rules resolve from Cursor-native SoT only — no harness-owned duplicate bodies on `development`; worktrees exclude ambient `.cursor/` skill dumps (§6.5).

---

## 16. Open questions for the caller

1. Coding runtime inside Eve sandbox vs Cursor/Codex CodingAgent adapters only?
2. ~~Hosting: VPS-only first, or Eve-on-Vercel for the control plane?~~ **Decided:** VPS Compose + BullMQ for the pipeline; Vercel = AI Gateway only (§14.0).
3. Merge: human-only vs auto-merge when CI + Jev + policy all pass?
4. Skill budget v1: planner-selected only, or start already orchestrator-restricted?
5. Agent UI: Langfuse default, or Phoenix first on a small Hetzner box?
6. Infra: SigNoz all-in-one, or Grafana Loki + Tempo + Prometheus?
7. Default coding backend for implementation: Cursor CLI or Codex CLI?
8. Per-provider concurrency caps for the first Hetzner box size?
9. Default JevRouter for v1 after TypeSafe pause lifts: stay on Vercel AI Gateway, switch to TypeSafe direct, or prefer Laya/poorjev local?
10. Should Hop 2 cache be exact-prompt only, or allow semantic cache with a similarity gate?
11. Exact Cursor layout path(s) for SoT (`.cursor/skills`, rules, commands, subagents) and how workflows share step defs with Cursor commands?
12. Minimal always-on **rules** subset for Eve sessions — which rule ids, and who approves changes?

---

## 17. Document history

- Created as pre-coding review spec from product conversation (New Bot–driven factory, selective skills, Jev, Eve, self-learning).
- Added §12 Observability and VPS operations (OTel, Langfuse/Phoenix, SigNoz/Grafana, canonical spans, Compose/systemd, secrets, backups); renumbered acceptance criteria and open questions; barred CrewAI/Temporal in v1.
- Added §13 Coding-model abstraction (Cursor/Codex adapters, model-agnostic prompts, usage tracking, rate limits, VPS git/sandbox concerns).
- Added §14 Proxy and routing architecture (Codex→LiteLLM, no Cursor MITM, two Jev hops, auth rewrite, cache/deny).
- Expanded §9 with Jev usage overview (gates, skill-budget, specialists, learning threshold, concurrency) beyond proxy hops.
- Added §6.5 Source of truth — Cursor-native definitions (no harness copies; Eve loads from SoT; worktree exclusion; commands↔workflows; rules vs skills); acceptance #13; open questions 11–12.
- v1 decision: Jev `jev` path via Vercel AI Gateway (temporary) while TypeSafe signup is paused — noted under §14.3.
- Architectural decision §14.0: BullMQ is the official issue-to-merge orchestrator (stage jobs wait/resume); Vercel is AI Gateway only — no Vercel Workflows/WDK; closed Inngest/Temporal alternatives in principles §1.6, §11, §12.7, open question #2.
