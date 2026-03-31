/**
 * Canonical pattern for orchestrator session IDs.
 *
 * Shared across orchestration operator surfaces and execute runtime to avoid
 * duplicated regex literals.
 */
export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{5,80}$/;
