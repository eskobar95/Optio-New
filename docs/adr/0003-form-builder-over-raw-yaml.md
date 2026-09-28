# ADR-0003: Form-builder over raw YAML

- **Status:** Accepted
- **Date:** 2026-09-28
- **Linear:** [ENG-28](https://linear.app/findjobabroad/issue/ENG-28), [ENG-29](https://linear.app/findjobabroad/issue/ENG-29)

## Context

Agent-/sub-agent-/skill-config er YAML under overfladen. Rå YAML er kraftfuldt men fejlbehæftet for hverdagsredigering.

## Decision

**Form-first:** GUI form-builder (Identity, Capabilities, Behavior, Integrations reference) **genererer YAML**. En **raw/code toggle** findes til manuel tuning. Form er primary — samme mønster som VS Code settings og Docker Compose UI’er.

Multi-format editors følger noden: Markdown (instructions), YAML (config), JSON kun når nødvendigt. Filtype vælges ikke frit.

## Consequences

**Positive**

- Lavere barrier for at oprette korrekte definitioner
- Én sandhed: form ↔ YAML, med eksplicit toggle
- Ens UX på tværs af agent / sub-agent / skill

**Negative / trade-offs**

- Form-schema skal holdes i sync med YAML-schema (ENG-35)
- Power-users kan stadig redigere raw; validation skal dække begge veje

## Alternatives considered

- Kun raw YAML/Markdown — hurtigere at bygge, værre DX
- Kun form uden raw — for stift til avancerede cases
