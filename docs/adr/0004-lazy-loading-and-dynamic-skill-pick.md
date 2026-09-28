# ADR-0004: Lazy loading and dynamic skill-pick

- **Status:** Accepted
- **Date:** 2026-09-28
- **Linear:** [ENG-25](https://linear.app/findjobabroad/issue/ENG-25), [ENG-28](https://linear.app/findjobabroad/issue/ENG-28), [ENG-36](https://linear.app/findjobabroad/issue/ENG-36)

## Context

Skill- og agent-biblioteker vokser. At loade alle bodies i kontekst er dyrt og støjende. Runtime skal vælge det relevante per task.

## Decision

1. **Lazy loading (katalog → body):** Catalog entry (`name` + `description`) først; **fuld body** først når noden/skill’en vælges eller Jev aktiverer den.
2. **Jev dynamic skill-pick:** Ved runtime vælger Jev hvilke skills (og capabilities) der loades **ud fra tasken** — ikke hardcoded “load hele allow-listen”. Allow-list er maksimal tilladelse; Jev vælger subset.
3. Flue binder definitioner per stage med lazy load; session continuity bevares på tværs af gates/retries (ENG-36).

## Consequences

**Positive**

- Mindre token-/kontekstforbrug
- Klarere agent-adfærd (kun relevante skills)
- Catalog forbliver browsebart uden at materialisere alt

**Negative / trade-offs**

- Jev-routing skal logges og være debuggable (ENG-25)
- Cold miss hvis pick er for aggressiv — retry/human gates dækker edge cases

## Alternatives considered

- Always load full allow-list — simpelt, dyrt, støjende
- Manuel skill-valg på hver stage — mere kontrol, mere friktion
