# specialists

Eve `subagents/` mirror. Each directory is a slot the implementation phase may call.

| Slot                     | Prompt source of truth       |
| ------------------------ | ---------------------------- |
| `specialists/front-end/` | `.cursor/agents/frontend.md` |
| `specialists/back-end/`  | `.cursor/agents/backend.md`  |
| `specialists/devops/`    | `.cursor/agents/devops.md`   |
| `specialists/database/`  | `.cursor/agents/database.md` |

`specialists/index.json` is the id → `.cursor/agents` map (`source_of_truth_root`). Slot `instructions.md` files point at that path and do not copy the prompt. `tools/` is optional and empty until a typed tool is added.

Contract: [docs/eve-patterns.md](../docs/eve-patterns.md).
