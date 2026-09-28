# ADR-0001: Vertical stack over node-canvas

- **Status:** Accepted
- **Date:** 2026-09-28
- **Linear:** [ENG-28](https://linear.app/findjobabroad/issue/ENG-28), [ENG-31](https://linear.app/findjobabroad/issue/ENG-31)

## Context

Workflows skal kunne bygges visuelt. To klassiske mønstre: **node-canvas** (n8n-stil: fri placering, edges) vs **vertical stack** (Zapier-stil: top-to-bottom rækker).

## Decision

Workflows bygges som en **vertical stack** — stages som kompakte rækker (icon, name, status badge) der expander **inline**. Parallelle branches er **indenterede sub-rækker**. Ingen fri canvas, ingen edges at tegne.

## Consequences

**Positive**

- Markant mindre UI-kompleksitet (ingen layout-engine, zoom, edge-routing)
- Flowet er lettere at læse som en lineær/indentereet liste
- Dataflow (receives / produces) kan vises per række uden at åbne noget

**Negative / trade-offs**

- Meget graf-agtige flows er mindre naturlige end på en canvas
- Aggregator/branch-UX skal designes omhyggeligt inden for stacken

## Alternatives considered

- **n8n-style node-canvas** — mere ekspressivt, men tungere UI og højere vedligehold
