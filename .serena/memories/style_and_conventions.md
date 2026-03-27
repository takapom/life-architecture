# Style and conventions
- Treat the repo as spec-first: requirements, architecture, database, and design docs define the intended implementation.
- Maintain modular-monolith boundaries from docs/architecture.md.
- Centralize shared types in `types/`, utilities in `lib/`, shared UI components separately from page logic, and constants/config in one place.
- Avoid duplicate logic and copy-paste implementations.
- For AI providers, keep the interface stable and add providers under `providers/`.
- React Flow visualization must remain read-only.
