---
name: code-review
description: Three-axis Standards, Spec, and Slop review of the diff since the integration-lane merge-base. Spec source is the Linear issue. Use for implement sanity checks and the checker agent.
---

# Code review

Load `factory.config.json` then `WORKFLOW.md`. Resolve names from [../_shared/factory.md](../_shared/factory.md).

Three-axis review of the diff between `HEAD` and a fixed point:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?
- **Slop** — prose filler, code slop, and narrating comments the diff introduces?

All three axes run as **parallel sub-agents** in the **same pass** so they do not pollute each other's context, then this skill aggregates their findings. Slop is not a gate before Spec or Standards.

This skill does not merge. The checker agent uses the result to choose `Ready for merge` vs `Implementing`.

## Process

### 1. Pin the fixed point

Default: merge-base with `origin/<lanes.integration>` (not `main`). If the user supplies a SHA, branch, tag, or `HEAD~n`, use that instead.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside parallel sub-agents.

### Inventory then delta (kit-slice Checker)

When the caller is the factory Checker (In Review / kit-slice), pin the range from the workpad `### Review pin` instead of always using merge-base:

| Pass | Mode | Range | What to write |
| --- | --- | --- | --- |
| 1 | **Inventory** | `merge-base...HEAD` (no `lastReviewSha`) | Every hard finding. Write `### Review pin` and `### Review color`. |
| 2+ | **Delta** | open Review feedback classes **plus** `lastReviewSha...HEAD` | Only still-open classes, or a regression created by the fix. |

Required checks pending → **amber** cheap hold: do **not** start the model review loop. Stay In Review.

Hard findings, `CONFLICTING`, or failed required checks → **red** → Implementing on the **same** branch/PR.

Axes clean **and** MERGEABLE **and** required checks green → **green** → Ready for merge.

Grapile is not a gate. Do not invent findings on unchanged hunks during delta.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. **PI factory-checker:** prefer the harness-injected review snapshot in the append (`## Spec source` + three-dot diff). Do not call Linear MCP `get_issue` / `list_comments` — they are not on the worker. Use `linear_cli` only to write `### Review feedback`. Do not read full `CONTEXT.md`. Do not poll `gh pr checks`.
2. Linear `<teamKey>-n` via `get_issue` **and** `list_comments` (workpad + `### Review feedback`) — Desktop / Cloud Agent only.
3. The project spec document on that issue's Linear project.
4. `{paths.specs}/<slug>/spec.md`.
5. A path the user passed as an argument.
6. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

When the injected snapshot is present, pin the fixed point from its Merge-base / Range lines instead of rediscovering via bash (readonly `git` only to fill gaps).

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`. Always include `WORKFLOW.md`, `.cursor/rules/`, and any architecture lock under `{paths.specs}/Architecture/` if it exists. If the diff touches `apps/mobile` or `apps/web`, also include `docs/design-system.md`.

If the diff touches `apps/mobile`, Expo config (`app.json` / `app.config.*`), or EAS (`eas.json`, EAS workflow YAML), also include `.cursor/skills/expo/expo-overview/SKILL.md` and the matching leaf skill(s) under `.cursor/skills/expo/`. Product docs (`CONTEXT.md`, ADRs, `docs/design-system.md`) override vendor Expo defaults on conflict.

**Code language:** Code identifiers, comments, and technical names are English (`.cursor/rules/code-english.mdc`). Danish user-facing UI copy may stay when the design lock says so. New Danish identifiers in the diff are a hard Standards finding — not a smell. Do not flag collector labels, empty states, or shipped Expo route slugs.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn all three sub-agents in parallel

Run **Standards**, **Spec**, and **Slop** in one parallel fan-out — not sequentially and not as a pre-gate.

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) **every** place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. List every hard finding; do not stop at the first three. A 400-word cap must not hide a hard miss — use a compact bullet list. Hard findings first, judgement calls after."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec (issue + comments + spec document).
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. List every hard miss; do not stop at the first three. Compact bullets. No word cap that would hide a hard miss."

**Slop sub-agent** — spawn the read-only `slop` agent (`.pi/agents/slop.md`). It has no memory-write tools. Prompt includes:

- The full diff command and commit list.
- The brief: "Apply the three Slop lenses (prose, code slop, narrating comments). List every **hard** finding; quote the hunk. When clean, report `- Slop: (none)`. Hard findings use a `Slop/` prefix on the workpad line."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the three reports under `## Standards`, `## Spec`, and `## Slop` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings across axes — the three axes are deliberately separate (see _Why three axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

When the caller is the checker agent: write **every** hard finding into `### Review feedback` in one fail — do not drip-feed. Use this shape:

```markdown
### Review feedback

- Spec: (none) | Spec: <finding>
- Standards: (none) | Standards: <finding>
- Slop: (none) | Slop/<finding>
```

Every axis must appear on pass and fail. Hard Slop findings use the `Slop/` prefix (not `Slop:`). A clean axis is `- Spec: (none)`, `- Standards: (none)`, or `- Slop: (none)`.

**First-pass tags (factory checker):** When a Standards or Slop finding matches a registered class in `.pi/first-pass-classes.json`, write `[first-pass:<id>]` on that workpad line (keep the axis prefix). Example: `- Standards: [first-pass:empty-state-body] EmptyState body must not be empty`. Untagged findings keep a full Scout+helpers resume. Do not invent harness product regexes — only tag registered ids.

Spec source is the whole Linear issue body (What to build + AC), not AC alone. A red required check is not a Spec-clean license — finish all three axes before the verdict. Hard Spec miss, hard Standards violation, hard Slop finding, `CONFLICTING` merge state, or failed required GitHub CI/CD checks (all required jobs, including image/deploy smokes) → Linear `Implementing`. Pending required checks → wait; stay in `In Review` (do not fail early on one axis while checks are still running). Otherwise → `Ready for merge` only when required GitHub checks are green **and** the PR is mergeable.

### Worker memory (checker parent only)

When the checker parent records a recurring **Standards** or **Slop** lesson via `memory_add`, use one schema: **`class → lesson`** with target `failure`. The **class** names the recurring mistake (e.g. `inline imports in Nest modules`, `narrating comments in harness tests`). The **lesson** states what to do differently — never a hunk, never a KIT identifier. **Never** `memory_add` Spec misses; Spec feedback stays on the workpad only. Sub-agents are read-only and must not call `memory_add`, `memory_replace`, or `memory_remove`. When this PR lands a git ratchet (`.cursor/hooks/`, `.cursor/rules/`, `scripts/check-*`) for a class you previously staged in Hermes, call `memory_remove` for that staging lesson so git wins.

## Why three axes

A change can pass one axis and fail another:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**
- Code that is correct and conventional but full of filler prose or narrating comments → **Slop fail.**

Reporting them separately stops one axis from masking another.
