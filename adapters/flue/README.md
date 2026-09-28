# adapters/flue

Flue is the **third** `CodingAgent` backend. Optio calls Flue over HTTP (`dispatch` / `start`); Cursor CLI is a tool Flue will call later — not this adapter.

TypeScript source: `../../src/adapters/flue/`. HTTP contract: [`docs/flue-contract.md`](../../docs/flue-contract.md).

Pick it with `resolveCodingBackend({ stepCodingBackend: "flue" })`. Base URL: `FLUE_BASE_URL` (default `http://127.0.0.1:3220`). Compose: `--profile flue`.

Stub sidecar + ENG-36 Optio-side session binding (resume same `durableConversationId`, review feedback accumulation, injectable Jev skill-pick port). No real Flue loop, no ENG-21 cursor-agent I/O, no ENG-25 Jev gates. See [`docs/flue-session-binding.md`](../../docs/flue-session-binding.md).
