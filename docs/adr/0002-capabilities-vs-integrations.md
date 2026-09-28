# ADR-0002: Capabilities vs integrations

- **Status:** Accepted
- **Date:** 2026-09-28
- **Linear:** [ENG-28](https://linear.app/findjobabroad/issue/ENG-28), [ENG-35](https://linear.app/findjobabroad/issue/ENG-35)

## Context

Agenter skal kunne kalde eksterne ting (MCP tools, Slack, Linear, GitHub) uden at kopiere credentials og config ind i hver node.

## Decision

**Separation rule:**

1. **MCP tools er capabilities** — tilladt på agent-, sub-agent- og skill-niveau via form-builder **Capabilities**-sektion (allow-list / toggles). Behandles som skills: procedurer/funktioner noden må kalde.
2. **Integrations** (GitHub, Linear, Slack) konfigureres **kun** på **workflow- eller workspace-niveau**. Noden holder højst en allow-list-reference (“må kalde Slack”), aldrig selve forbindelsen.
3. **Ingen overlap:** MCP tools optræder ikke i workflow integration-config; Slack/Linear/GitHub-forbindelser optræder ikke inde i nodens form-builder.

## Consequences

**Positive**

- Én Slack-/GitHub-/Linear-forbindelse, refereret mange steder — ingen duplicate config
- Nodens allow-list forbliver lille og eksplicit
- Credentials forbliver på workflow/workspace (Infisical / secrets) — ikke i agent-YAML

**Negative / trade-offs**

- UX skal klart skelne “Capabilities” vs “Integrations reference (read-only)”
- Custom stage-moduler til integrations lever i module picker, ikke i node-form

## Alternatives considered

- Putte Slack/Linear/GitHub inde i hver agent — fører til duplicate secrets og drift
- Behandle MCP som workflow-integrations — blander “procedure-katalog” med “forbindelser”
