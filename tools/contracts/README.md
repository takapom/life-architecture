# Tools Contracts

`tools/contracts/*` stores canonical machine-readable contracts for the repo operations platform.

- `execution-plan.schema.json`: canonical schema for orchestration execution-plan artifacts.
- `execution-plan-task-scope.contract.json`: canonical task-scope derivation data used by both TypeScript and Rust execution-plan validators.
- `execution-plan.ts`: canonical TypeScript binding layer for execution-plan schema, payload types, and task-scope derivation helpers.
- `repoctl-rpc.contract.json`: canonical local daemon socket/RPC contract for repoctl/repoctld coordination.
- `repoctl-session-lease.schema.json`: canonical session-lease payload schema for task ownership, heartbeat, and release semantics.
- `repoctl-coordination-digest.schema.json`: canonical bounded coordination digest schema for denied/granted/status feedback.
- `repoctl-state-store.contract.json`: canonical SQLite state-store contract for durable local repoctl coordination state.
- `repo-operations-platform-target-state.json`: canonical machine-readable ideal-state and gap-inventory contract for Repo Operations Platform convergence.
- `tool-operational-evidence.schema.json`: canonical schema for `/tools` runtime success/failure/latency evidence written under `.omta/tool-operational-evidence/*.ndjson`.
- `fixtures/execution-plan.valid.json`: parity fixture consumed by both TypeScript and Rust tests.

Runtime-specific validators may add semantic checks, but they must not redefine the canonical payload surface away from the schemas in this directory.
