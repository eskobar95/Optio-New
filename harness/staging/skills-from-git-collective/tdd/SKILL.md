---
name: tdd
description: Test-driven development for this factory. Red-green at spec seams. Domain helpers write tests at their layer. Use from /implement, or when building test-first.
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle — consult them before and during the loop, not after.

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

Load `factory.config.json` then `WORKFLOW.md` when this run is part of `/implement`.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test. You can't test everything — agreeing the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?"

**Factory twist — who confirms the seams**

- Human `/tdd` session: confirm seams with the user before any test. No test at an unconfirmed seam.
- Unattended `/implement`: seams are already in the spec’s Testing Decisions (and the issue). Copy them into the workpad. Do not invent extra seams. Do not ping the human. If the spec listed none, use the highest public interface that covers the acceptance criteria and record it in the workpad.

When the shape of that interface is itself in question — how deep the module is, where the seam belongs, what the interface should expose — consult `/codebase-design`. Prefer existing seams and the architecture lock under `{paths.specs}/Architecture/` over a new seam.

## Domain helpers in the loop

This skill picks the helpers. `/implement` still owns Linear status and the PR.

Before the first red test, list every agent file in `paths.helpers` (default `.cursor/agents/*.md`). Read each YAML `name` and `description`. Do not use a hardcoded roster.

For the current seam / slice, spawn **every Role** whose `description` matches (Frontend, Backend, DevOps). Skip files whose description is not this job (planner, checker, release) and skip deprecated aliases (`Do not spawn from /tdd`). A slice that matches a Role description and whose workpad still says `(none)` is a process miss — spawn before the PR. An issue that cites `docs/design-system.md` or named lock components matches **Frontend** even when Backend already matched.

Write the chosen Role names in the workpad under `### Domain helpers used`.

Roles load **Area skills** on demand (not as agent ids): Expo, Nest, design-system. Frontend loads design-system before Expo leaves. Backend loads Nest when HTTP/auth is in scope. Data/Drizzle stays under Backend in v1. Product docs win on conflict with vendor Expo defaults.

The helper:

1. Writes the **failing** test at that seam (red)
2. Writes only enough production code to pass it (green)
3. Returns the diff and the test command to the implementer

The implementer (or a human `/tdd` session):

- Verifies red then green. Do not skip red.
- Runs the helper’s targeted test command
- Does not let a helper change Linear status or open a PR

If no helper matches the seam, run the cycle yourself.

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead — one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to `/code-review`, not the red → green implementation cycle.
