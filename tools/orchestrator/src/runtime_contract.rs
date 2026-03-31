use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use jsonschema::Validator;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionPlanIssueTracking {
    #[serde(default)]
    pub strategy: String,
    pub repository: String,
    #[serde(default)]
    pub node_issue_mode: String,
    #[serde(default)]
    pub progress_issue_number: u64,
    #[serde(default)]
    pub progress_issue_url: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionPlanTaskScope {
    #[serde(default)]
    pub owner_bucket: String,
    #[serde(default)]
    pub owner_buckets: Vec<String>,
    #[serde(default)]
    pub conflict_class: String,
    #[serde(default = "default_execution_plan_task_scope_admission_mode")]
    pub admission_mode: String,
    #[serde(default)]
    pub global_invariant: String,
    #[serde(default)]
    pub unfreeze_condition: String,
    #[serde(default)]
    pub verification_class: String,
    #[serde(default)]
    pub scope_gate_keys: Vec<String>,
    #[serde(default)]
    pub serialized_scope_keys: Vec<String>,
    #[serde(default)]
    pub hot_root_paths: Vec<String>,
    #[serde(default)]
    pub resource_claims: Vec<ExecutionPlanResourceClaim>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionPlanResourceClaim {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub resource: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionPlanSourceItem {
    pub id: String,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub github_issue: String,
    #[serde(default)]
    pub parent_issue_number: u64,
    #[serde(default)]
    pub parent_issue_url: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionPlanDeferredItem {
    pub id: String,
    #[serde(default)]
    pub reason: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionPlanNode {
    pub id: String,
    #[serde(default)]
    pub issue_node_id: String,
    pub branch: String,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub github_issue: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub allowed_files: Vec<String>,
    #[serde(default)]
    pub commit_units: Vec<String>,
    #[serde(default)]
    pub non_goals: Vec<String>,
    #[serde(default)]
    pub acceptance_checks: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    #[serde(default)]
    pub covers: Vec<String>,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub task_scope: Option<ExecutionPlanTaskScope>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionPlan {
    #[serde(default = "default_base_branch")]
    pub base_branch: String,
    #[serde(default)]
    pub max_workers: u64,
    #[serde(default)]
    pub merge_mode: String,
    #[serde(default)]
    pub merge_queue: bool,
    #[serde(default)]
    pub cleanup: bool,
    #[serde(default)]
    pub queue_strategy: String,
    #[serde(default)]
    pub require_passing_tests: bool,
    #[serde(default)]
    pub require_traceability: bool,
    #[serde(default)]
    pub require_acceptance_checks: bool,
    pub issue_tracking: ExecutionPlanIssueTracking,
    #[serde(default)]
    pub source_items: Vec<ExecutionPlanSourceItem>,
    #[serde(default)]
    pub issue_map: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub deferred_items: Vec<ExecutionPlanDeferredItem>,
    pub nodes: Vec<ExecutionPlanNode>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct StateNode {
    pub status: String,
    pub branch: String,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub attempts: u64,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub last_activity_at: Option<String>,
    #[serde(default)]
    pub worktree_prepared: bool,
    #[serde(default)]
    pub event_seq: u64,
    #[serde(default)]
    pub event_last_status: String,
    #[serde(default)]
    pub claim_run_id: String,
    #[serde(default)]
    pub claim_owner: String,
    #[serde(default)]
    pub claim_lease_expires_at: String,
    #[serde(default)]
    pub retry_ready_at: String,
    #[serde(default)]
    pub retry_exhausted_at: String,
    #[serde(default)]
    pub last_failure_reason: String,
    #[serde(default)]
    pub last_failure_summary: String,
    #[serde(default)]
    pub blocked_reason: String,
    #[serde(default)]
    pub escalation_level: String,
    #[serde(default)]
    pub escalation_reason: String,
    #[serde(default)]
    pub last_update: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct GithubState {
    #[serde(default = "default_state_backend")]
    pub state_backend: String,
    #[serde(default)]
    pub repository: String,
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub run_issue_number: u64,
    #[serde(default)]
    pub run_issue_url: String,
    #[serde(default)]
    pub initialized_at: String,
}

impl Default for GithubState {
    fn default() -> Self {
        Self {
            state_backend: default_state_backend(),
            repository: String::new(),
            run_id: String::new(),
            run_issue_number: 0,
            run_issue_url: String::new(),
            initialized_at: String::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct RuntimeMetadata {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub worktree_root: String,
    #[serde(default)]
    pub worktree_root_source: String,
    #[serde(default)]
    pub repo_root: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct StatePayload {
    #[serde(default)]
    pub updated_at: String,
    pub nodes: std::collections::BTreeMap<String, StateNode>,
    #[serde(default)]
    pub github_state: GithubState,
    #[serde(default)]
    pub runtime: RuntimeMetadata,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct GateArtifacts {
    #[serde(default)]
    pub status_json: String,
    #[serde(default)]
    pub conflict_json: String,
    #[serde(default)]
    pub review_json: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct GateNode {
    pub node_id: String,
    pub status: String,
    pub branch: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub failure_reason: String,
    #[serde(default)]
    pub pr_url: String,
    #[serde(default)]
    pub artifacts: GateArtifacts,
}

#[derive(Debug, Deserialize, Clone)]
pub struct GateResultsPayload {
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub state_updated_at: String,
    #[serde(default)]
    pub nodes: Vec<GateNode>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct StatusPayload {
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub failure_reason: String,
    #[serde(default)]
    pub timestamp: String,
}

fn default_base_branch() -> String {
    "main".to_string()
}

fn default_state_backend() -> String {
    "local".to_string()
}

fn default_execution_plan_task_scope_admission_mode() -> String {
    "standard".to_string()
}

#[derive(Debug, Deserialize, Clone)]
struct ExecutionPlanTaskScopeContract {
    conflict_classes: Vec<String>,
    admission_modes: Vec<String>,
    verification_classes: Vec<String>,
    #[allow(dead_code)]
    admission_sources: Vec<String>,
    #[allow(dead_code)]
    verification_source: String,
    #[allow(dead_code)]
    commit_units_required: bool,
    serialized_scope_key_by_scope_gate_key: std::collections::BTreeMap<String, String>,
    implementation_owner_roots: Vec<String>,
    ops_roots: Vec<String>,
    repo_root_files: Vec<String>,
    hot_root_patterns: Vec<String>,
    full_build_sensitive_patterns: Vec<String>,
}

fn execution_plan_task_scope_contract() -> Result<&'static ExecutionPlanTaskScopeContract, String> {
    static CONTRACT: OnceLock<Result<ExecutionPlanTaskScopeContract, String>> = OnceLock::new();
    CONTRACT
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../contracts/execution-plan-task-scope.contract.json"
            ))
            .map_err(|error| {
                format!("failed to parse embedded execution-plan task-scope contract: {error}")
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn normalize_path_pattern(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

fn normalize_string_vec(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn arrays_equal(left: &[String], right: &[String]) -> bool {
    left.len() == right.len() && left.iter().zip(right.iter()).all(|(a, b)| a == b)
}

fn has_glob(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.contains('[')
}

fn glob_prefix(pattern: &str) -> String {
    let normalized = normalize_path_pattern(pattern);
    let wildcard_index = normalized
        .char_indices()
        .find(|(_, ch)| matches!(ch, '*' | '?' | '['))
        .map(|(index, _)| index);
    match wildcard_index {
        Some(index) => normalized[..index].trim_end_matches('/').to_string(),
        None => normalized,
    }
}

fn glob_to_regex(pattern: &str) -> Result<Regex, String> {
    let mut source = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied().unwrap_or_default();
        if current == '*' && next == '*' {
            source.push_str(".*");
            index += 2;
            continue;
        }
        if current == '*' {
            source.push_str("[^/]*");
            index += 1;
            continue;
        }
        if current == '?' {
            source.push_str("[^/]");
            index += 1;
            continue;
        }
        source.push_str(&regex::escape(&current.to_string()));
        index += 1;
    }
    source.push('$');
    Regex::new(&source)
        .map_err(|error| format!("invalid generated glob regex '{pattern}': {error}"))
}

fn matches_path_glob(value: &str, pattern: &str) -> Result<bool, String> {
    let normalized_value = normalize_path_pattern(value);
    let normalized_pattern = normalize_path_pattern(pattern);
    if normalized_value.is_empty() || normalized_pattern.is_empty() {
        return Ok(false);
    }
    Ok(glob_to_regex(&normalized_pattern)?.is_match(&normalized_value))
}

fn overlaps_path_pattern(left: &str, right: &str) -> Result<bool, String> {
    let a = normalize_path_pattern(left);
    let b = normalize_path_pattern(right);
    if a.is_empty() || b.is_empty() {
        return Ok(false);
    }
    if a == b {
        return Ok(true);
    }

    let a_has_glob = has_glob(&a);
    let b_has_glob = has_glob(&b);
    if !a_has_glob && !b_has_glob {
        return Ok(false);
    }
    if !a_has_glob {
        return matches_path_glob(&a, &b);
    }
    if !b_has_glob {
        return matches_path_glob(&b, &a);
    }

    let a_prefix = glob_prefix(&a);
    let b_prefix = glob_prefix(&b);
    if a_prefix.is_empty() || b_prefix.is_empty() {
        return Ok(true);
    }
    Ok(a_prefix == b_prefix
        || a_prefix.starts_with(&format!("{b_prefix}/"))
        || b_prefix.starts_with(&format!("{a_prefix}/")))
}

fn trim_glob_suffix(value: &str) -> String {
    let wildcard_index = value
        .char_indices()
        .find(|(_, ch)| matches!(ch, '*' | '?' | '['))
        .map(|(index, _)| index);
    match wildcard_index {
        Some(index) => value[..index].trim_end_matches('/').to_string(),
        None => value.trim_end_matches('/').to_string(),
    }
}

fn normalize_scope_path(value: &str) -> String {
    trim_glob_suffix(&normalize_path_pattern(value))
}

fn normalize_allowed_globs(allowed_files: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for pattern in allowed_files {
        let candidate = normalize_path_pattern(pattern);
        if candidate.is_empty() || normalized.iter().any(|entry| entry == &candidate) {
            continue;
        }
        normalized.push(candidate);
    }
    normalized
}

fn extract_top_level_roots(patterns: &[String]) -> Vec<String> {
    let mut roots = std::collections::BTreeSet::new();
    for pattern in patterns {
        let normalized = normalize_path_pattern(pattern);
        if normalized.is_empty() {
            continue;
        }
        let trimmed = normalized.trim_start_matches('/');
        let root = trimmed
            .split('/')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("(root)");
        roots.insert(root.to_string());
    }
    roots.into_iter().collect()
}

fn extract_owner_buckets(patterns: &[String]) -> Result<Vec<String>, String> {
    let contract = execution_plan_task_scope_contract()?;
    let implementation_roots = contract
        .implementation_owner_roots
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let mut buckets = std::collections::BTreeSet::new();

    for pattern in patterns {
        let normalized = normalize_path_pattern(pattern);
        if normalized.is_empty() {
            continue;
        }
        let parts = normalized
            .trim_start_matches('/')
            .split('/')
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>();
        let root = parts.first().copied().unwrap_or_default();
        let owner = parts.get(1).copied().unwrap_or_default();
        if root.is_empty() {
            continue;
        }
        if implementation_roots.contains(root) && !owner.is_empty() {
            buckets.insert(format!("{root}/{owner}"));
        } else {
            buckets.insert(root.to_string());
        }
    }

    Ok(buckets.into_iter().collect())
}

fn extract_hot_root_paths(patterns: &[String]) -> Result<Vec<String>, String> {
    let contract = execution_plan_task_scope_contract()?;
    let normalized_patterns = normalize_allowed_globs(patterns);
    let mut matches = Vec::new();
    for pattern in normalized_patterns {
        let mut matched = false;
        for hot_root in &contract.hot_root_patterns {
            if overlaps_path_pattern(&pattern, hot_root)? {
                matched = true;
                break;
            }
        }
        if matched {
            matches.push(pattern);
        }
    }
    matches.sort();
    Ok(matches)
}

fn resolve_scope_gate_key_candidates(path_pattern: &str) -> Result<Vec<String>, String> {
    let contract = execution_plan_task_scope_contract()?;
    let normalized = normalize_scope_path(path_pattern);
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let parts = normalized
        .split('/')
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    let root = parts.first().copied().unwrap_or_default();
    let owner = parts.get(1).copied().unwrap_or_default();
    let child = parts.get(2).copied().unwrap_or_default();
    if root.is_empty() {
        return Ok(Vec::new());
    }

    if root == "apps" {
        return Ok(match owner {
            "api" => vec!["api".to_string(), "apps".to_string(), "repo".to_string()],
            "app" => vec!["app".to_string(), "apps".to_string(), "repo".to_string()],
            "platform-admin" => vec![
                "platform-admin".to_string(),
                "apps".to_string(),
                "repo".to_string(),
            ],
            "public-docs" => vec![
                "public-docs".to_string(),
                "apps".to_string(),
                "repo".to_string(),
            ],
            "worker" => vec!["worker".to_string(), "apps".to_string(), "repo".to_string()],
            "agent-runner" => vec![
                "agent-runner".to_string(),
                "worker".to_string(),
                "apps".to_string(),
                "repo".to_string(),
            ],
            "agent-session-runtime" => vec![
                "agent-session-runtime".to_string(),
                "worker".to_string(),
                "apps".to_string(),
                "repo".to_string(),
            ],
            _ if owner.is_empty() => vec!["apps".to_string(), "repo".to_string()],
            _ => vec![owner.to_string(), "apps".to_string(), "repo".to_string()],
        });
    }

    if contract
        .implementation_owner_roots
        .iter()
        .any(|entry| entry == root)
        && root != "apps"
    {
        if !owner.is_empty() {
            return Ok(vec![
                format!("{root}/{owner}"),
                root.to_string(),
                "repo".to_string(),
            ]);
        }
        return Ok(vec![root.to_string(), "repo".to_string()]);
    }

    if root == "docs" {
        if normalized == "docs/README.md" || normalized == "docs/contracts/README.md" {
            return Ok(vec![
                "docs-index".to_string(),
                "repo-governance".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if normalized == "docs/contracts/documentation-system.md" {
            return Ok(vec![
                "documentation-system".to_string(),
                "repo-governance".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "contracts" && child == "governance" {
            let leaf = parts.get(3).copied().unwrap_or_default();
            if leaf == "command-surface.md" {
                return Ok(vec![
                    "command-surface".to_string(),
                    "repo-governance".to_string(),
                    "ops".to_string(),
                    "repo".to_string(),
                ]);
            }
            if leaf == "task-scope.md" || leaf == "workflow.md" {
                return Ok(vec![
                    "task-governance".to_string(),
                    "ops".to_string(),
                    "repo".to_string(),
                ]);
            }
            return Ok(vec![
                "repo-governance".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "generated" {
            return Ok(vec![
                "generated-tooling".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "contracts"
            || owner == "guides"
            || owner == "references"
            || owner == "runbooks"
            || owner == "aliases"
        {
            return Ok(vec![
                "repo-governance".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        return Ok(vec![
            "repo-governance".to_string(),
            "ops".to_string(),
            "repo".to_string(),
        ]);
    }

    if root == "platform" && owner == "dev" && (child == "local" || child == "worktree") {
        return Ok(vec![
            "worktree-runtime".to_string(),
            "ops".to_string(),
            "repo".to_string(),
        ]);
    }

    if root == "platform" && owner == "delivery" && child == "ci" {
        return Ok(vec![
            "delivery-ci".to_string(),
            "ops".to_string(),
            "repo".to_string(),
        ]);
    }

    if root == "platform" && owner == "delivery" && child == "gitops" {
        return Ok(vec![
            "gitops".to_string(),
            "ops".to_string(),
            "repo".to_string(),
        ]);
    }

    if root == "tools" {
        if owner == "repoctl" {
            return Ok(vec![
                "repoctl".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "generated" {
            return Ok(vec![
                "generated-tooling".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "scanners" {
            return Ok(vec![
                "repo-policy".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "core"
            && (normalized == "tools/core/task-issue-catalog.ts"
                || normalized == "tools/core/task-issue-catalog.test.ts")
        {
            return Ok(vec![
                "repoctl".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "core" || owner == "contracts" {
            return Ok(vec![
                "task-governance".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner == "orchestrator" {
            if child == "pr" {
                return Ok(vec![
                    "publish".to_string(),
                    "ops".to_string(),
                    "repo".to_string(),
                ]);
            }
            if child == "task" {
                return Ok(vec![
                    "task-governance".to_string(),
                    "ops".to_string(),
                    "repo".to_string(),
                ]);
            }
            return Ok(vec![
                "task-governance".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        return Ok(vec!["ops".to_string(), "repo".to_string()]);
    }

    if root == "scripts" {
        if owner.starts_with("check-") || owner.starts_with("fix-") {
            return Ok(vec![
                "repo-policy".to_string(),
                "scripts".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        if owner.starts_with("report-") {
            return Ok(vec![
                "generated-tooling".to_string(),
                "scripts".to_string(),
                "ops".to_string(),
                "repo".to_string(),
            ]);
        }
        return Ok(vec![
            "scripts".to_string(),
            "ops".to_string(),
            "repo".to_string(),
        ]);
    }

    if contract.ops_roots.iter().any(|entry| entry == root) {
        return Ok(vec!["ops".to_string(), "repo".to_string()]);
    }

    if contract.repo_root_files.iter().any(|entry| entry == root) {
        return Ok(vec!["repo".to_string()]);
    }

    Ok(vec!["repo".to_string()])
}

fn resolve_scope_gate_keys(allowed_files: &[String]) -> Result<Vec<String>, String> {
    let mut resolved = Vec::new();
    for allowed_file in allowed_files {
        let candidates = resolve_scope_gate_key_candidates(allowed_file)?;
        if let Some(selected) = candidates.first() {
            if !resolved.iter().any(|entry| entry == selected) {
                resolved.push(selected.clone());
            }
        }
    }
    Ok(resolved)
}

fn derive_execution_plan_resource_claims(
    allowed_globs: &[String],
) -> Result<Vec<ExecutionPlanResourceClaim>, String> {
    let rules: [(&str, &[&str]); 5] = [
        (
            "task-scope-policy-engine",
            &[
                "tools/core/task-scope.ts",
                "tools/core/task-scope/**",
                "platform/dev/worktree/task-pr-steady-state.ts",
                "platform/delivery/ci/local-pre-push.ts",
                "tools/apps/task/check-task-pr-steady-state.ts",
            ],
        ),
        (
            "execution-plan-writer",
            &[
                "tools/orchestrator/runtime/export-execution-plan.ts",
                "tools/orchestrator/runtime/execution-plan-contract.ts",
                "tools/orchestrator/src/runtime_contract.rs",
            ],
        ),
        (
            "codex-launch-contract",
            &[
                "platform/dev/local/start-codex.ts",
                "platform/dev/worktree/codex-write-scope.ts",
                "platform/dev/worktree/worktree-topology.ts",
            ],
        ),
        (
            "main-worktree-guard",
            &[
                "platform/dev/worktree/task-pr-steady-state.ts",
                "tools/apps/task/check-task-pr-steady-state.ts",
                "platform/dev/worktree/task-worktree-protection.ts",
            ],
        ),
        (
            "verify-cache-writer",
            &[
                "tools/core/task-scope/verify-cache.ts",
                "platform/delivery/ci/local-pre-push.ts",
            ],
        ),
    ];
    let mut claims = Vec::new();
    for (resource, patterns) in rules {
        let mut matched = false;
        for allowed_glob in allowed_globs {
            for pattern in patterns {
                if overlaps_path_pattern(allowed_glob, pattern)? {
                    matched = true;
                    break;
                }
            }
            if matched {
                break;
            }
        }
        if matched {
            claims.push(ExecutionPlanResourceClaim {
                mode: "exclusive".to_string(),
                resource: resource.to_string(),
            });
        }
    }

    let managed_rust_patterns = [
        "tools/adapters/rust-runtime.ts",
        "tools/repoctl/**",
        "scripts/check-managed-rust-runtime.ts",
        "platform/dev/local/**",
    ];
    let mut managed_rust_matched = false;
    for allowed_glob in allowed_globs {
        for pattern in managed_rust_patterns {
            if overlaps_path_pattern(allowed_glob, pattern)? {
                managed_rust_matched = true;
                break;
            }
        }
        if managed_rust_matched {
            break;
        }
    }
    if managed_rust_matched {
        claims.push(ExecutionPlanResourceClaim {
            mode: "exclusive".to_string(),
            resource: "managed-rust-runtime".to_string(),
        });
    }

    claims.sort_by(|left, right| left.resource.cmp(&right.resource));
    claims.dedup_by(|left, right| left.resource == right.resource && left.mode == right.mode);
    Ok(claims)
}

fn resolve_serialized_scope_keys(scope_gate_keys: &[String]) -> Result<Vec<String>, String> {
    let contract = execution_plan_task_scope_contract()?;
    let mut serialized_scope_keys = Vec::new();
    for scope_key in scope_gate_keys {
        let serialized = contract
            .serialized_scope_key_by_scope_gate_key
            .get(scope_key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                if scope_key.starts_with("packages/")
                    || scope_key.starts_with("domains/")
                    || scope_key.starts_with("processes/")
                {
                    scope_key.replace('/', "_")
                } else {
                    scope_key.to_string()
                }
            });
        if !serialized_scope_keys
            .iter()
            .any(|entry| entry == &serialized)
        {
            serialized_scope_keys.push(serialized);
        }
    }
    Ok(serialized_scope_keys)
}

fn build_execution_plan_task_scope(
    allowed_files: &[String],
    _commit_units: &[String],
    admission_mode: Option<&str>,
    global_invariant: Option<&str>,
    unfreeze_condition: Option<&str>,
) -> Result<ExecutionPlanTaskScope, String> {
    let contract = execution_plan_task_scope_contract()?;
    let allowed_globs = normalize_allowed_globs(allowed_files);
    let top_level_roots = extract_top_level_roots(&allowed_globs);
    let owner_buckets = extract_owner_buckets(&allowed_globs)?;
    let owner_bucket_count = owner_buckets.len();
    let hot_root_paths = extract_hot_root_paths(&allowed_globs)?;
    let touches_hot_root = !hot_root_paths.is_empty();
    let scope_gate_keys = resolve_scope_gate_keys(&allowed_globs)?;
    let serialized_scope_keys = resolve_serialized_scope_keys(&scope_gate_keys)?;

    let mut touches_full_build_sensitive_pattern = false;
    for pattern in &allowed_globs {
        for sensitive in &contract.full_build_sensitive_patterns {
            if overlaps_path_pattern(pattern, sensitive)? {
                touches_full_build_sensitive_pattern = true;
                break;
            }
        }
        if touches_full_build_sensitive_pattern {
            break;
        }
    }

    let verification_class = if touches_hot_root || touches_full_build_sensitive_pattern {
        "full-build-sensitive".to_string()
    } else if top_level_roots.iter().any(|root| {
        contract
            .implementation_owner_roots
            .iter()
            .any(|entry| entry == root)
    }) {
        "affected-typecheck".to_string()
    } else {
        "cheap".to_string()
    };
    let normalized_admission_mode =
        match admission_mode.unwrap_or("").trim().to_lowercase().as_str() {
            "landing-exclusive" => "landing-exclusive".to_string(),
            "global-exclusive" => "global-exclusive".to_string(),
            _ => "standard".to_string(),
        };
    let normalized_global_invariant = if normalized_admission_mode == "global-exclusive" {
        global_invariant.unwrap_or("").trim().to_string()
    } else {
        String::new()
    };
    let normalized_unfreeze_condition = if normalized_admission_mode == "global-exclusive" {
        unfreeze_condition.unwrap_or("").trim().to_string()
    } else {
        String::new()
    };

    Ok(ExecutionPlanTaskScope {
        owner_bucket: owner_buckets
            .first()
            .cloned()
            .unwrap_or_else(|| "(root)".to_string()),
        owner_buckets,
        conflict_class: if touches_hot_root {
            "integration-hot".to_string()
        } else if owner_bucket_count <= 1 {
            "parallel-safe".to_string()
        } else {
            "serial".to_string()
        },
        admission_mode: normalized_admission_mode,
        global_invariant: normalized_global_invariant,
        unfreeze_condition: normalized_unfreeze_condition,
        verification_class,
        scope_gate_keys,
        serialized_scope_keys,
        hot_root_paths,
        resource_claims: derive_execution_plan_resource_claims(&allowed_globs)?,
    })
}

fn parse_repository_slug(value: &str) -> Option<(String, String)> {
    let parts = value
        .split('/')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    if parts.len() != 2 {
        return None;
    }
    Some((parts[0].to_string(), parts[1].to_string()))
}

fn parse_github_issue_url(value: &str) -> Option<(String, String, u64)> {
    static ISSUE_RE: OnceLock<Regex> = OnceLock::new();
    let re = ISSUE_RE.get_or_init(|| {
        Regex::new(r"^https://github\.com/([^/]+)/([^/]+)/issues/([1-9][0-9]*)$").expect("regex")
    });
    let captures = re.captures(value.trim())?;
    let owner = captures.get(1)?.as_str().to_string();
    let repo = captures.get(2)?.as_str().to_string();
    let number = captures.get(3)?.as_str().parse::<u64>().ok()?;
    Some((owner, repo, number))
}

fn validate_execution_plan_semantics(plan: &ExecutionPlan) -> Result<Vec<String>, String> {
    let contract = execution_plan_task_scope_contract()?;
    let mut errors = Vec::new();
    let mut repository_slug = String::new();

    if plan.base_branch.trim().is_empty() {
        errors.push("execution plan base_branch is required".to_string());
    }
    if plan.max_workers == 0 {
        errors.push("execution plan max_workers must be >= 1".to_string());
    }
    if plan.merge_mode.trim() != "remote-pr" {
        errors.push("execution plan merge_mode must be remote-pr".to_string());
    }
    if plan.queue_strategy.trim() != "dag_priority" {
        errors.push("execution plan queue_strategy must be dag_priority".to_string());
    }
    if plan.issue_tracking.strategy.trim() != "remote-github-sot" {
        errors.push("issue_tracking.strategy must be remote-github-sot".to_string());
    }
    if plan.issue_tracking.node_issue_mode.trim() != "per-node" {
        errors.push("issue_tracking.node_issue_mode must be per-node".to_string());
    }
    if let Some((owner, repo)) = parse_repository_slug(&plan.issue_tracking.repository) {
        repository_slug = format!("{owner}/{repo}");
    } else {
        errors.push("issue_tracking.repository must be <owner>/<repo>".to_string());
    }

    let progress_issue_url = plan.issue_tracking.progress_issue_url.trim();
    if !progress_issue_url.is_empty() {
        match parse_github_issue_url(progress_issue_url) {
            Some((owner, repo, number)) => {
                if plan.issue_tracking.progress_issue_number > 0
                    && number != plan.issue_tracking.progress_issue_number
                {
                    errors.push(format!(
                        "issue_tracking.progress_issue_url issue number must match progress_issue_number ({})",
                        plan.issue_tracking.progress_issue_number
                    ));
                }
                if !repository_slug.is_empty() && repository_slug != format!("{owner}/{repo}") {
                    errors.push(format!(
                        "issue_tracking.progress_issue_url must reference https://github.com/{}/issues/<number>",
                        repository_slug
                    ));
                }
            }
            None => errors.push(
                "issue_tracking.progress_issue_url must be https://github.com/<owner>/<repo>/issues/<number>"
                    .to_string(),
            ),
        }
    }

    if plan.source_items.is_empty() {
        errors.push("missing source_items array".to_string());
    }
    if plan.issue_map.is_empty() {
        errors.push("issue_map must not be empty".to_string());
    }
    if plan.nodes.is_empty() {
        errors.push("nodes must be a non-empty array".to_string());
    }

    let mut issue_map_by_id = std::collections::BTreeMap::new();
    let mut source_id_by_issue_url = std::collections::BTreeMap::new();
    for (source_id, issue_url) in &plan.issue_map {
        let trimmed_id = source_id.trim();
        let trimmed_issue_url = issue_url.trim();
        if trimmed_id.is_empty() {
            errors.push("issue_map keys must not be empty".to_string());
            continue;
        }
        if trimmed_issue_url.is_empty() {
            errors.push(format!(
                "issue_map.{trimmed_id} must be a non-empty issue URL"
            ));
            continue;
        }
        let normalized_issue_url = trimmed_issue_url.to_lowercase();
        if let Some(duplicate_source) = source_id_by_issue_url.get(&normalized_issue_url) {
            if duplicate_source != trimmed_id {
                errors.push(format!(
                    "issue_map must not map multiple source ids to the same issue URL: {duplicate_source}, {trimmed_id} -> {trimmed_issue_url}"
                ));
            }
        } else {
            source_id_by_issue_url.insert(normalized_issue_url, trimmed_id.to_string());
        }
        issue_map_by_id.insert(trimmed_id.to_string(), trimmed_issue_url.to_string());
    }

    let mut source_verdict_by_id = std::collections::BTreeMap::new();
    let mut source_parent_issue_by_id = std::collections::BTreeMap::new();
    for (index, item) in plan.source_items.iter().enumerate() {
        let id = item.id.trim();
        let verdict = item.verdict.trim().to_lowercase();
        let github_issue = item.github_issue.trim();
        let parent_issue_number = item.parent_issue_number;
        let parent_issue_url = item.parent_issue_url.trim();
        if id.is_empty() {
            errors.push(format!("source_items[{index}].id is required"));
            continue;
        }
        if source_verdict_by_id.contains_key(id) {
            errors.push(format!("source_items id must be unique: {id}"));
        }
        if item.summary.trim().is_empty() {
            errors.push(format!("source_items[{index}].summary is required"));
        }
        if !["valid", "already-fixed", "invalid", "pending"]
            .iter()
            .any(|candidate| candidate == &verdict)
        {
            errors.push(format!(
                "source_items[{index}] verdict must be one of valid|already-fixed|invalid|pending"
            ));
            continue;
        }
        if github_issue.is_empty() {
            errors.push(format!("source_items[{index}].github_issue is required"));
        }

        let has_parent_issue_number = parent_issue_number > 0;
        let has_parent_issue_url = !parent_issue_url.is_empty();
        if has_parent_issue_number != has_parent_issue_url {
            errors.push(format!(
                "source_items[{index}] must set parent_issue_number and parent_issue_url together"
            ));
        }
        if has_parent_issue_url {
            match parse_github_issue_url(parent_issue_url) {
                Some((owner, repo, number)) => {
                    if number != parent_issue_number {
                        errors.push(format!(
                            "source_items[{index}].parent_issue_url issue number must match parent_issue_number ({parent_issue_number})"
                        ));
                    }
                    if !repository_slug.is_empty() && repository_slug != format!("{owner}/{repo}") {
                        errors.push(format!(
                            "source_items.{id}.parent_issue_url must reference https://github.com/{repository_slug}/issues/<number>"
                        ));
                    }
                }
                None => errors.push(format!(
                    "source_items[{index}].parent_issue_url must be https://github.com/<owner>/<repo>/issues/<number>"
                )),
            }
        }

        source_verdict_by_id.insert(id.to_string(), verdict.clone());
        if !github_issue.is_empty() {
            if let Some(mapped_issue_url) = issue_map_by_id.get(id) {
                if !mapped_issue_url.eq_ignore_ascii_case(github_issue) {
                    errors.push(format!(
                        "source_items.{id}.github_issue must match issue_map.{id}"
                    ));
                }
            }
            if !repository_slug.is_empty() {
                match parse_github_issue_url(github_issue) {
                    Some((owner, repo, _)) => {
                        if repository_slug != format!("{owner}/{repo}") {
                            errors.push(format!(
                                "source_items.{id}.github_issue must reference https://github.com/{repository_slug}/issues/<number>"
                            ));
                        }
                    }
                    None => errors.push(format!(
                        "source_items.{id}.github_issue must reference https://github.com/{repository_slug}/issues/<number>"
                    )),
                }
            }
        }
        if has_parent_issue_number && has_parent_issue_url {
            source_parent_issue_by_id.insert(
                id.to_string(),
                (parent_issue_number, parent_issue_url.to_string()),
            );
        }
    }

    let deferred_ids = plan
        .deferred_items
        .iter()
        .map(|item| item.id.trim().to_string())
        .collect::<Vec<_>>();
    for item in &plan.deferred_items {
        if item.id.trim().is_empty() {
            errors.push("deferred_items[].id is required".to_string());
        }
        if item.reason.trim().is_empty() {
            errors.push(format!(
                "deferred_items.{}.reason is required",
                item.id.trim()
            ));
        }
        if !item.id.trim().is_empty() && !source_verdict_by_id.contains_key(item.id.trim()) {
            errors.push(format!(
                "deferred_items references unknown source id {}",
                item.id.trim()
            ));
        }
    }

    let mut node_ids = std::collections::BTreeSet::new();
    let mut node_issue_by_id = std::collections::BTreeMap::new();
    let mut node_id_by_issue_url = std::collections::BTreeMap::new();
    let mut source_cover_count = std::collections::BTreeMap::new();
    for node in &plan.nodes {
        let id = node.id.trim();
        let github_issue = node.github_issue.trim();
        if id.is_empty() {
            errors.push("nodes[].id is required".to_string());
        } else if !node_ids.insert(id.to_string()) {
            errors.push(format!("nodes[].id must be unique: {id}"));
        }
        if node.branch.trim().is_empty() {
            errors.push(format!("node {}: branch is required", fallback_node_id(id)));
        }
        if node.issue_node_id.trim().is_empty() {
            errors.push(format!(
                "node {}: issue_node_id is required",
                fallback_node_id(id)
            ));
        }
        if node.priority < 0 {
            errors.push(format!(
                "node {}: priority must be a non-negative integer",
                fallback_node_id(id)
            ));
        }
        if normalize_string_vec(&node.allowed_files).is_empty() {
            errors.push(format!(
                "node {}: allowed_files is required",
                fallback_node_id(id)
            ));
        }
        if normalize_string_vec(&node.commit_units).is_empty() {
            errors.push(format!(
                "node {}: commit_units is required",
                fallback_node_id(id)
            ));
        }
        if normalize_string_vec(&node.acceptance_checks).is_empty() {
            errors.push(format!(
                "node {}: acceptance_checks is required",
                fallback_node_id(id)
            ));
        }
        if normalize_string_vec(&node.tests).is_empty() {
            errors.push(format!("node {}: tests is required", fallback_node_id(id)));
        }
        if node.instructions.trim().is_empty() {
            errors.push(format!(
                "node {}: instructions is required",
                fallback_node_id(id)
            ));
        }
        if github_issue.is_empty() {
            errors.push(format!(
                "node {}: github_issue is required",
                fallback_node_id(id)
            ));
        } else {
            let normalized_issue_url = github_issue.to_lowercase();
            if let Some(duplicate_node) = node_id_by_issue_url.get(&normalized_issue_url) {
                if duplicate_node != id {
                    errors.push(format!(
                        "nodes must not share github_issue URL: {duplicate_node} and {} -> {github_issue}",
                        fallback_node_id(id)
                    ));
                }
            } else if !id.is_empty() {
                node_id_by_issue_url.insert(normalized_issue_url, id.to_string());
                node_issue_by_id.insert(id.to_string(), github_issue.to_string());
            }
        }
        if node.covers.len() != 1 {
            errors.push(format!(
                "node {}: covers must contain exactly one source id",
                fallback_node_id(id)
            ));
        } else {
            let cover_id = node.covers[0].trim();
            if cover_id.is_empty() {
                errors.push(format!(
                    "node {}: covers[] must be non-empty strings",
                    fallback_node_id(id)
                ));
            } else if !source_verdict_by_id.contains_key(cover_id) {
                errors.push(format!(
                    "node {}: covers references unknown source id {cover_id}",
                    fallback_node_id(id)
                ));
            } else {
                if let Some(mapped_issue_url) = issue_map_by_id.get(cover_id) {
                    if !github_issue.is_empty()
                        && !mapped_issue_url.eq_ignore_ascii_case(github_issue)
                    {
                        errors.push(format!(
                            "node {}: github_issue must match issue_map.{cover_id} ({mapped_issue_url})",
                            fallback_node_id(id)
                        ));
                    }
                }
                *source_cover_count
                    .entry(cover_id.to_string())
                    .or_insert(0usize) += 1;
            }
        }

        match &node.task_scope {
            Some(task_scope) => {
                let owner_buckets = normalize_string_vec(&task_scope.owner_buckets);
                let scope_gate_keys = normalize_string_vec(&task_scope.scope_gate_keys);
                let serialized_scope_keys = normalize_string_vec(&task_scope.serialized_scope_keys);
                let hot_root_paths = normalize_string_vec(&task_scope.hot_root_paths);
                let resource_claims = task_scope
                    .resource_claims
                    .iter()
                    .map(|claim| {
                        (
                            claim.mode.trim().to_string(),
                            claim.resource.trim().to_string(),
                        )
                    })
                    .collect::<Vec<_>>();
                if task_scope.owner_bucket.trim().is_empty() {
                    errors.push(format!(
                        "node {}: task_scope.owner_bucket is required",
                        fallback_node_id(id)
                    ));
                }
                if owner_buckets.is_empty() {
                    errors.push(format!(
                        "node {}: task_scope.owner_buckets is required",
                        fallback_node_id(id)
                    ));
                }
                if !contract
                    .conflict_classes
                    .iter()
                    .any(|candidate| candidate == task_scope.conflict_class.trim())
                {
                    errors.push(format!(
                        "node {}: task_scope.conflict_class must be one of {}",
                        fallback_node_id(id),
                        contract.conflict_classes.join("|")
                    ));
                }
                if !contract
                    .admission_modes
                    .iter()
                    .any(|candidate| candidate == task_scope.admission_mode.trim())
                {
                    errors.push(format!(
                        "node {}: task_scope.admission_mode must be one of {}",
                        fallback_node_id(id),
                        contract.admission_modes.join("|")
                    ));
                }
                if task_scope.admission_mode.trim() == "global-exclusive"
                    && (task_scope.global_invariant.trim().is_empty()
                        || task_scope.unfreeze_condition.trim().is_empty())
                {
                    errors.push(format!(
                        "node {}: task_scope.global_invariant and task_scope.unfreeze_condition are required when task_scope.admission_mode=global-exclusive",
                        fallback_node_id(id)
                    ));
                }
                if (task_scope.admission_mode.trim() == "standard"
                    || task_scope.admission_mode.trim() == "landing-exclusive")
                    && (!task_scope.global_invariant.trim().is_empty()
                        || !task_scope.unfreeze_condition.trim().is_empty())
                {
                    errors.push(format!(
                        "node {}: task_scope.global_invariant and task_scope.unfreeze_condition must be empty when task_scope.admission_mode=standard|landing-exclusive",
                        fallback_node_id(id)
                    ));
                }
                if !contract
                    .verification_classes
                    .iter()
                    .any(|candidate| candidate == task_scope.verification_class.trim())
                {
                    errors.push(format!(
                        "node {}: task_scope.verification_class must be one of {}",
                        fallback_node_id(id),
                        contract.verification_classes.join("|")
                    ));
                }
                if scope_gate_keys.is_empty() {
                    errors.push(format!(
                        "node {}: task_scope.scope_gate_keys is required",
                        fallback_node_id(id)
                    ));
                }

                let expected = build_execution_plan_task_scope(
                    &node.allowed_files,
                    &node.commit_units,
                    Some(task_scope.admission_mode.as_str()),
                    Some(task_scope.global_invariant.as_str()),
                    Some(task_scope.unfreeze_condition.as_str()),
                )?;
                if !task_scope.owner_bucket.trim().is_empty()
                    && task_scope.owner_bucket.trim() != expected.owner_bucket
                {
                    errors.push(format!(
                        "node {}: task_scope.owner_bucket must match allowed_files derivation ({})",
                        fallback_node_id(id),
                        expected.owner_bucket
                    ));
                }
                if !owner_buckets.is_empty()
                    && !arrays_equal(&owner_buckets, &expected.owner_buckets)
                {
                    errors.push(format!(
                        "node {}: task_scope.owner_buckets drift from allowed_files",
                        fallback_node_id(id)
                    ));
                }
                if contract
                    .conflict_classes
                    .iter()
                    .any(|candidate| candidate == task_scope.conflict_class.trim())
                    && task_scope.conflict_class.trim() != expected.conflict_class
                {
                    errors.push(format!(
                        "node {}: task_scope.conflict_class must match allowed_files derivation ({})",
                        fallback_node_id(id),
                        expected.conflict_class
                    ));
                }
                if contract
                    .admission_modes
                    .iter()
                    .any(|candidate| candidate == task_scope.admission_mode.trim())
                    && task_scope.admission_mode.trim() != expected.admission_mode
                {
                    errors.push(format!(
                        "node {}: task_scope.admission_mode must stay internally consistent ({})",
                        fallback_node_id(id),
                        expected.admission_mode
                    ));
                }
                if task_scope.global_invariant.trim() != expected.global_invariant {
                    errors.push(format!(
                        "node {}: task_scope.global_invariant drift from canonical admission payload",
                        fallback_node_id(id)
                    ));
                }
                if task_scope.unfreeze_condition.trim() != expected.unfreeze_condition {
                    errors.push(format!(
                        "node {}: task_scope.unfreeze_condition drift from canonical admission payload",
                        fallback_node_id(id)
                    ));
                }
                if contract
                    .verification_classes
                    .iter()
                    .any(|candidate| candidate == task_scope.verification_class.trim())
                    && task_scope.verification_class.trim() != expected.verification_class
                {
                    errors.push(format!(
                        "node {}: task_scope.verification_class must match allowed_files derivation ({})",
                        fallback_node_id(id),
                        expected.verification_class
                    ));
                }
                if !scope_gate_keys.is_empty()
                    && !arrays_equal(&scope_gate_keys, &expected.scope_gate_keys)
                {
                    errors.push(format!(
                        "node {}: task_scope.scope_gate_keys drift from allowed_files",
                        fallback_node_id(id)
                    ));
                }
                if !serialized_scope_keys.is_empty()
                    && !arrays_equal(&serialized_scope_keys, &expected.serialized_scope_keys)
                {
                    errors.push(format!(
                        "node {}: task_scope.serialized_scope_keys drift from allowed_files",
                        fallback_node_id(id)
                    ));
                }
                if !arrays_equal(&hot_root_paths, &expected.hot_root_paths) {
                    errors.push(format!(
                        "node {}: task_scope.hot_root_paths drift from allowed_files",
                        fallback_node_id(id)
                    ));
                }
                let expected_resource_claims = expected
                    .resource_claims
                    .iter()
                    .map(|claim| {
                        (
                            claim.mode.trim().to_string(),
                            claim.resource.trim().to_string(),
                        )
                    })
                    .collect::<Vec<_>>();
                if resource_claims != expected_resource_claims {
                    errors.push(format!(
                        "node {}: task_scope.resource_claims drift from canonical admission payload",
                        fallback_node_id(id)
                    ));
                }
            }
            None => errors.push(format!(
                "node {}: task_scope is required",
                fallback_node_id(id)
            )),
        }
    }

    for source_id in source_verdict_by_id.keys() {
        if !issue_map_by_id.contains_key(source_id) {
            errors.push(format!("issue_map is missing source id: {source_id}"));
        }
    }
    for issue_map_id in issue_map_by_id.keys() {
        if !source_verdict_by_id.contains_key(issue_map_id) {
            errors.push(format!(
                "issue_map contains unknown source id: {issue_map_id}"
            ));
        }
    }

    if !repository_slug.is_empty() {
        for (source_id, issue_url) in &issue_map_by_id {
            match parse_github_issue_url(issue_url) {
                Some((owner, repo, _)) => {
                    if repository_slug != format!("{owner}/{repo}") {
                        errors.push(format!(
                            "issue_map.{source_id} must reference https://github.com/{repository_slug}/issues/<number>"
                        ));
                    }
                }
                None => errors.push(format!(
                    "issue_map.{source_id} must reference https://github.com/{repository_slug}/issues/<number>"
                )),
            }
            if let Some((_, parent_url)) = source_parent_issue_by_id.get(source_id) {
                if parent_url.eq_ignore_ascii_case(issue_url) {
                    errors.push(format!(
                        "source_items.{source_id}.parent_issue_url must not be the same as issue_map.{source_id}"
                    ));
                }
            }
        }
        for (node_id, issue_url) in &node_issue_by_id {
            match parse_github_issue_url(issue_url) {
                Some((owner, repo, _)) => {
                    if repository_slug != format!("{owner}/{repo}") {
                        errors.push(format!(
                            "node {node_id}: github_issue must reference https://github.com/{repository_slug}/issues/<number>"
                        ));
                    }
                }
                None => errors.push(format!(
                    "node {node_id}: github_issue must reference https://github.com/{repository_slug}/issues/<number>"
                )),
            }
        }
    }

    for (source_id, verdict) in &source_verdict_by_id {
        let cover_count = *source_cover_count.get(source_id).unwrap_or(&0usize);
        if verdict == "valid" && cover_count != 1 {
            errors.push(format!(
                "valid source item {source_id} must be covered by exactly one node"
            ));
        }
        if verdict != "valid" && cover_count != 0 {
            errors.push(format!(
                "non-valid source item {source_id} must not be covered by nodes"
            ));
        }
        if cover_count > 1 {
            errors.push(format!(
                "source item {source_id} is covered by multiple nodes"
            ));
        }
        if verdict == "pending" && !deferred_ids.iter().any(|candidate| candidate == source_id) {
            errors.push(format!(
                "pending source item {source_id} must appear in deferred_items"
            ));
        }
    }

    Ok(errors)
}

fn fallback_node_id(id: &str) -> String {
    if id.trim().is_empty() {
        "<unknown>".to_string()
    } else {
        id.trim().to_string()
    }
}

fn execution_plan_schema_validator() -> Result<Validator, String> {
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../contracts/execution-plan.schema.json"))
            .map_err(|error| format!("failed to parse embedded execution-plan schema: {error}"))?;
    jsonschema::validator_for(&schema)
        .map_err(|error| format!("failed to compile execution-plan schema: {error}"))
}

fn validate_execution_plan_schema(raw: &serde_json::Value, path: &Path) -> Result<(), String> {
    let validator = execution_plan_schema_validator()?;
    let errors: Vec<String> = validator
        .iter_errors(raw)
        .map(|error| format!("{}: {}", error.instance_path(), error))
        .collect();
    if errors.is_empty() {
        return Ok(());
    }
    Err(format!(
        "execution plan schema validation failed: {}\n- {}",
        path.display(),
        errors.join("\n- ")
    ))
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub fn read_execution_plan(path: &Path) -> Result<ExecutionPlan, String> {
    let raw: serde_json::Value = read_json_file(path)?;
    validate_execution_plan_schema(&raw, path)?;
    let plan: ExecutionPlan = serde_json::from_value(raw)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    let errors = validate_execution_plan_semantics(&plan)?;
    if !errors.is_empty() {
        return Err(format!(
            "execution plan semantic validation failed: {}\n- {}",
            path.display(),
            errors.join("\n- ")
        ));
    }
    Ok(plan)
}

pub fn read_state_payload(path: &Path) -> Result<StatePayload, String> {
    let state: StatePayload = read_json_file(path)?;
    if state.nodes.is_empty() {
        return Err(format!("state nodes must not be empty: {}", path.display()));
    }
    Ok(state)
}

pub fn read_gate_results_payload(path: &Path) -> Result<GateResultsPayload, String> {
    let payload: GateResultsPayload = read_json_file(path)?;
    if payload.generated_at.trim().is_empty() {
        return Err(format!(
            "gate results generated_at is required: {}",
            path.display()
        ));
    }
    if payload.state_updated_at.trim().is_empty() {
        return Err(format!(
            "gate results state_updated_at is required: {}",
            path.display()
        ));
    }
    for node in &payload.nodes {
        if node.node_id.trim().is_empty()
            || node.status.trim().is_empty()
            || node.branch.trim().is_empty()
        {
            return Err(format!(
                "gate results nodes must include non-empty node_id, status, and branch: {}",
                path.display()
            ));
        }
        if matches!(node.status.as_str(), "failed" | "blocked")
            && node.failure_reason.trim().is_empty()
        {
            return Err(format!(
                "gate results failed/blocked nodes must include failure_reason: {}",
                path.display()
            ));
        }
        if node.status == "done" && node.pr_url.trim().is_empty() {
            return Err(format!(
                "gate results done nodes must include pr_url: {}",
                path.display()
            ));
        }
        for artifact_path in [
            node.artifacts.status_json.trim(),
            node.artifacts.conflict_json.trim(),
            node.artifacts.review_json.trim(),
        ] {
            if !artifact_path.is_empty() && Path::new(artifact_path).is_absolute() {
                return Err(format!(
                    "gate results artifact paths must stay relative: {}",
                    path.display()
                ));
            }
        }
        let _ = node.summary.trim();
    }
    Ok(payload)
}

pub fn build_initial_state(nodes: &[ExecutionPlanNode], now_iso: &str) -> StatePayload {
    let mut state_nodes = std::collections::BTreeMap::new();
    for node in nodes {
        state_nodes.insert(
            node.id.clone(),
            StateNode {
                status: "pending".to_string(),
                attempts: 0,
                branch: node.branch.clone(),
                deps: node.deps.clone(),
                worktree: None,
                started_at: None,
                last_activity_at: None,
                worktree_prepared: false,
                event_seq: 0,
                event_last_status: String::new(),
                claim_run_id: String::new(),
                claim_owner: String::new(),
                claim_lease_expires_at: String::new(),
                retry_ready_at: String::new(),
                retry_exhausted_at: String::new(),
                last_failure_reason: String::new(),
                last_failure_summary: String::new(),
                blocked_reason: String::new(),
                escalation_level: "none".to_string(),
                escalation_reason: String::new(),
                last_update: now_iso.to_string(),
            },
        );
    }

    StatePayload {
        updated_at: now_iso.to_string(),
        nodes: state_nodes,
        github_state: GithubState::default(),
        runtime: RuntimeMetadata::default(),
    }
}

pub fn normalize_state_shape(state: &mut StatePayload, nodes: &[ExecutionPlanNode], now_iso: &str) {
    if state.github_state.state_backend.trim().is_empty() {
        state.github_state.state_backend = default_state_backend();
    }
    if state.runtime.worktree_root_source.trim().is_empty() {
        state.runtime.worktree_root_source = "session-default".to_string();
    }
    for node in nodes {
        state
            .nodes
            .entry(node.id.clone())
            .or_insert_with(|| StateNode {
                status: "pending".to_string(),
                attempts: 0,
                branch: node.branch.clone(),
                deps: node.deps.clone(),
                worktree: None,
                started_at: None,
                last_activity_at: None,
                worktree_prepared: false,
                event_seq: 0,
                event_last_status: String::new(),
                claim_run_id: String::new(),
                claim_owner: String::new(),
                claim_lease_expires_at: String::new(),
                retry_ready_at: String::new(),
                retry_exhausted_at: String::new(),
                last_failure_reason: String::new(),
                last_failure_summary: String::new(),
                blocked_reason: String::new(),
                escalation_level: "none".to_string(),
                escalation_reason: String::new(),
                last_update: now_iso.to_string(),
            });
    }
}

fn canonical_status_path(state_dir: &Path, node_id: &str) -> std::path::PathBuf {
    state_dir.join("status").join(format!("{node_id}.json"))
}

fn worktree_status_path(worktree_path: &str, node_id: &str) -> std::path::PathBuf {
    Path::new(worktree_path)
        .join(".orchestrator")
        .join("status")
        .join(format!("{node_id}.json"))
}

fn invalid_status_payload(node_id: &str, message: &str, source: &str) -> StatusPayload {
    StatusPayload {
        node_id: node_id.to_string(),
        status: "failed".to_string(),
        summary: format!("invalid status json ({source}): {message}"),
        failure_reason: "status_json_invalid".to_string(),
        timestamp: String::new(),
    }
}

pub fn load_node_status(
    state_dir: &Path,
    node_state: &StateNode,
    node_id: &str,
) -> Result<Option<StatusPayload>, String> {
    let canonical_path = canonical_status_path(state_dir, node_id);
    if canonical_path.is_file() {
        return match read_json_file(&canonical_path) {
            Ok(payload) => Ok(Some(payload)),
            Err(error) => {
                let invalid = invalid_status_payload(node_id, &error, "canonical");
                let parent = canonical_path.parent().ok_or_else(|| {
                    format!(
                        "invalid canonical status path: {}",
                        canonical_path.display()
                    )
                })?;
                fs::create_dir_all(parent)
                    .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
                fs::write(
                    &canonical_path,
                    serde_json::to_string_pretty(&invalid).unwrap() + "\n",
                )
                .map_err(|err| format!("failed to write {}: {err}", canonical_path.display()))?;
                Ok(Some(invalid))
            }
        };
    }

    let Some(worktree) = node_state
        .worktree
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    let worktree_path = worktree_status_path(worktree, node_id);
    if !worktree_path.is_file() {
        return Ok(None);
    }
    let payload: StatusPayload = match read_json_file(&worktree_path) {
        Ok(payload) => payload,
        Err(error) => {
            let invalid = invalid_status_payload(node_id, &error, "worktree");
            let parent = canonical_path.parent().ok_or_else(|| {
                format!(
                    "invalid canonical status path: {}",
                    canonical_path.display()
                )
            })?;
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
            fs::write(
                &canonical_path,
                serde_json::to_string_pretty(&invalid).unwrap() + "\n",
            )
            .map_err(|err| format!("failed to write {}: {err}", canonical_path.display()))?;
            return Ok(Some(invalid));
        }
    };
    let parent = canonical_path.parent().ok_or_else(|| {
        format!(
            "invalid canonical status path: {}",
            canonical_path.display()
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    fs::write(
        &canonical_path,
        serde_json::to_string_pretty(&payload).unwrap() + "\n",
    )
    .map_err(|err| format!("failed to write {}: {err}", canonical_path.display()))?;
    Ok(Some(payload))
}

pub fn recover_transient_nodes(
    state: &mut StatePayload,
    state_dir: &Path,
    merge_queue_enabled: bool,
    now_iso: &str,
) -> Result<bool, String> {
    let mut changed = false;
    let node_ids = state.nodes.keys().cloned().collect::<Vec<_>>();
    for node_id in node_ids {
        let status = state
            .nodes
            .get(&node_id)
            .map(|entry| entry.status.clone())
            .unwrap_or_default();
        match status.as_str() {
            "running" => {
                let child_status = {
                    let node_state = state.nodes.get(&node_id).expect("node exists");
                    load_node_status(state_dir, node_state, &node_id)?
                        .map(|payload| payload.status)
                        .unwrap_or_default()
                };
                let next_status = match child_status.as_str() {
                    "ready_for_review" | "blocked" | "failed" => child_status,
                    _ => "pending".to_string(),
                };
                if let Some(node_state) = state.nodes.get_mut(&node_id) {
                    node_state.status = next_status;
                    node_state.last_update = now_iso.to_string();
                    changed = true;
                }
            }
            "merging" => {
                if let Some(node_state) = state.nodes.get_mut(&node_id) {
                    node_state.status = "pending".to_string();
                    node_state.last_update = now_iso.to_string();
                    changed = true;
                }
            }
            "queued" if !merge_queue_enabled => {
                if let Some(node_state) = state.nodes.get_mut(&node_id) {
                    node_state.status = "pending".to_string();
                    node_state.last_update = now_iso.to_string();
                    changed = true;
                }
            }
            _ => {}
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn canonical_execution_plan_value() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../contracts/fixtures/execution-plan.valid.json"
        ))
        .expect("fixture json")
    }

    fn unique_temp_path(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("{name}-{unique}.json"))
    }

    #[test]
    fn read_execution_plan_requires_non_empty_nodes() {
        let mut raw = canonical_execution_plan_value();
        raw["nodes"] = serde_json::json!([]);
        let path = Path::new("/tmp/execution-plan.json");
        let raw_text = raw.to_string();
        let parsed: ExecutionPlan = serde_json::from_str(&raw_text).expect("parse");
        assert!(parsed.nodes.is_empty());
        let error = {
            let temp_dir = unique_temp_path("omta-runtime-contract-plan");
            fs::write(&temp_dir, raw_text).expect("write");
            let result = read_execution_plan(&temp_dir);
            let _ = fs::remove_file(&temp_dir);
            result.expect_err("expected error")
        };
        assert!(
            error.contains(
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .as_ref()
            ) || error.contains("nodes must not be empty")
                || error.contains("\"nodes\"")
                || error.contains("/nodes")
        );
    }

    #[test]
    fn read_execution_plan_preserves_canonical_contract_fields() {
        let mut raw = canonical_execution_plan_value();
        raw["issue_tracking"]["progress_issue_number"] = serde_json::json!(42);
        raw["issue_tracking"]["progress_issue_url"] =
            serde_json::json!("https://github.com/Omluc/omta/issues/42");
        raw["nodes"][0]["priority"] = serde_json::json!(7);
        let temp_path = unique_temp_path("omta-runtime-contract-plan-priority");
        fs::write(&temp_path, raw.to_string()).expect("write");
        let parsed = read_execution_plan(&temp_path).expect("plan");
        let _ = fs::remove_file(&temp_path);
        assert_eq!(parsed.max_workers, 4);
        assert!(!parsed.merge_queue);
        assert!(parsed.cleanup);
        assert_eq!(parsed.queue_strategy, "dag_priority");
        assert_eq!(parsed.issue_tracking.strategy, "remote-github-sot");
        assert_eq!(parsed.issue_tracking.node_issue_mode, "per-node");
        assert_eq!(parsed.issue_tracking.progress_issue_number, 42);
        assert_eq!(
            parsed.issue_tracking.progress_issue_url,
            "https://github.com/Omluc/omta/issues/42"
        );
        assert_eq!(parsed.source_items.len(), 2);
        assert_eq!(
            parsed.source_items[0].github_issue,
            "https://github.com/Omluc/omta/issues/100"
        );
        assert_eq!(
            parsed.issue_map.get("FC-1").map(String::as_str),
            Some("https://github.com/Omluc/omta/issues/100")
        );
        assert_eq!(parsed.deferred_items[0].id, "FC-2");
        assert_eq!(parsed.nodes[0].priority, 7);
        assert_eq!(parsed.nodes[0].issue_node_id, "NODE_OPS-900001");
        assert_eq!(parsed.nodes[0].covers, vec!["FC-1".to_string()]);
        assert_eq!(
            parsed.nodes[0]
                .task_scope
                .as_ref()
                .expect("task scope")
                .admission_mode,
            "standard"
        );
        assert_eq!(
            parsed.nodes[0]
                .task_scope
                .as_ref()
                .expect("task scope")
                .global_invariant,
            ""
        );
        assert_eq!(
            parsed.nodes[0]
                .task_scope
                .as_ref()
                .expect("task scope")
                .unfreeze_condition,
            ""
        );
        assert_eq!(
            parsed.nodes[0]
                .task_scope
                .as_ref()
                .expect("task scope")
                .serialized_scope_keys,
            vec!["task_governance_control_plane".to_string()]
        );
    }

    #[test]
    fn read_execution_plan_rejects_task_scope_drift_from_allowed_files() {
        let mut raw = canonical_execution_plan_value();
        raw["nodes"][0]["task_scope"]["verification_class"] =
            serde_json::json!("full-build-sensitive");
        let temp_path = unique_temp_path("omta-runtime-contract-plan-scope-drift");
        fs::write(&temp_path, raw.to_string()).expect("write");
        let error = read_execution_plan(&temp_path).expect_err("expected drift error");
        let _ = fs::remove_file(&temp_path);
        assert!(
            error.contains("task_scope.verification_class must match allowed_files derivation")
        );
    }

    #[test]
    fn read_execution_plan_rejects_global_exclusive_scope_without_invariant_payload() {
        let mut raw = canonical_execution_plan_value();
        raw["nodes"][0]["task_scope"]["admission_mode"] = serde_json::json!("global-exclusive");
        raw["nodes"][0]["task_scope"]["global_invariant"] = serde_json::json!("");
        raw["nodes"][0]["task_scope"]["unfreeze_condition"] = serde_json::json!("");
        let temp_path = unique_temp_path("omta-runtime-contract-plan-global-exclusive-payload");
        fs::write(&temp_path, raw.to_string()).expect("write");
        let error = read_execution_plan(&temp_path).expect_err("expected admission payload error");
        let _ = fs::remove_file(&temp_path);
        assert!(
            error.contains(
                "task_scope.global_invariant and task_scope.unfreeze_condition are required when task_scope.admission_mode=global-exclusive"
            )
        );
    }

    #[test]
    fn read_execution_plan_rejects_pending_source_without_deferred_item() {
        let mut raw = canonical_execution_plan_value();
        raw["deferred_items"] = serde_json::json!([]);
        let temp_path = unique_temp_path("omta-runtime-contract-plan-pending-without-deferred");
        fs::write(&temp_path, raw.to_string()).expect("write");
        let error = read_execution_plan(&temp_path).expect_err("expected deferred error");
        let _ = fs::remove_file(&temp_path);
        assert!(error.contains("pending source item FC-2 must appear in deferred_items"));
    }

    #[test]
    fn read_state_payload_parses_close_state_shape() {
        let raw = serde_json::json!({
            "updated_at": "2026-03-07T07:00:00Z",
            "nodes": {
                "OPS-1": {
                    "status": "done",
                    "branch": "task/ops-1",
                    "worktree": "../wt/OPS-1",
                    "attempts": 1,
                    "last_update": "2026-03-07T07:00:00Z"
                }
            }
        });
        let temp_path = unique_temp_path("omta-runtime-contract-state");
        fs::write(&temp_path, raw.to_string()).expect("write");
        let parsed = read_state_payload(&temp_path).expect("state");
        let _ = fs::remove_file(&temp_path);
        assert_eq!(parsed.nodes["OPS-1"].status, "done");
        assert_eq!(parsed.nodes["OPS-1"].branch, "task/ops-1");
        assert_eq!(
            parsed.nodes["OPS-1"].worktree.as_deref(),
            Some("../wt/OPS-1")
        );
    }

    #[test]
    fn read_gate_results_payload_parses_gate_shape() {
        let raw = serde_json::json!({
            "generated_at": "2026-03-07T07:00:00Z",
            "state_updated_at": "2026-03-07T07:00:00Z",
            "nodes": [
                {
                    "node_id": "OPS-1",
                    "status": "done",
                    "branch": "task/ops-1",
                    "summary": "ok",
                    "failure_reason": "",
                    "pr_url": "https://github.com/Omluc/omta/pull/42",
                    "artifacts": {
                        "status_json": "status/OPS-1.json",
                        "conflict_json": "",
                        "review_json": "review/OPS-1.json"
                    }
                }
            ]
        });
        let temp_path = unique_temp_path("omta-runtime-contract-gate");
        fs::write(&temp_path, raw.to_string()).expect("write");
        let parsed = read_gate_results_payload(&temp_path).expect("gate");
        let _ = fs::remove_file(&temp_path);
        assert_eq!(parsed.generated_at, "2026-03-07T07:00:00Z");
        assert_eq!(parsed.state_updated_at, "2026-03-07T07:00:00Z");
        assert_eq!(parsed.nodes.len(), 1);
        assert_eq!(parsed.nodes[0].node_id, "OPS-1");
        assert_eq!(parsed.nodes[0].status, "done");
        assert_eq!(parsed.nodes[0].branch, "task/ops-1");
        assert_eq!(parsed.nodes[0].summary, "ok");
        assert_eq!(parsed.nodes[0].failure_reason, "");
        assert_eq!(
            parsed.nodes[0].pr_url,
            "https://github.com/Omluc/omta/pull/42"
        );
        assert_eq!(parsed.nodes[0].artifacts.status_json, "status/OPS-1.json");
        assert_eq!(parsed.nodes[0].artifacts.conflict_json, "");
        assert_eq!(parsed.nodes[0].artifacts.review_json, "review/OPS-1.json");
    }

    #[test]
    fn build_initial_state_seeds_pending_nodes() {
        let state = build_initial_state(
            &[ExecutionPlanNode {
                id: "OPS-1".to_string(),
                issue_node_id: "NODE_OPS-1".to_string(),
                branch: "task/ops-1".to_string(),
                deps: vec!["OPS-0".to_string()],
                priority: 0,
                github_issue: String::new(),
                scope: String::new(),
                allowed_files: Vec::new(),
                commit_units: vec!["CU1".to_string()],
                non_goals: Vec::new(),
                acceptance_checks: Vec::new(),
                tests: Vec::new(),
                covers: Vec::new(),
                instructions: String::new(),
                task_scope: None,
            }],
            "2026-03-25T12:00:00Z",
        );
        assert_eq!(state.nodes["OPS-1"].status, "pending");
        assert_eq!(state.nodes["OPS-1"].branch, "task/ops-1");
        assert_eq!(state.nodes["OPS-1"].deps, vec!["OPS-0".to_string()]);
        assert_eq!(state.github_state.state_backend, "local");
    }

    #[test]
    fn recover_transient_nodes_replays_worktree_status_into_canonical_state() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let temp_root = std::env::temp_dir().join(format!(
            "omta-runtime-contract-recover-{}-{unique_suffix}",
            std::process::id(),
        ));
        let _ = fs::remove_dir_all(&temp_root);
        fs::create_dir_all(temp_root.join("status")).expect("status dir");
        fs::create_dir_all(temp_root.join("wt").join(".orchestrator").join("status"))
            .expect("worktree status dir");
        fs::write(
            temp_root
                .join("wt")
                .join(".orchestrator")
                .join("status")
                .join("OPS-1.json"),
            serde_json::json!({
                "node_id": "OPS-1",
                "status": "ready_for_review",
                "summary": "child finished"
            })
            .to_string(),
        )
        .expect("write status");

        let mut state = StatePayload {
            updated_at: String::new(),
            github_state: GithubState::default(),
            runtime: RuntimeMetadata::default(),
            nodes: [(
                "OPS-1".to_string(),
                StateNode {
                    status: "running".to_string(),
                    branch: "task/ops-1".to_string(),
                    deps: vec![],
                    worktree: Some(temp_root.join("wt").display().to_string()),
                    attempts: 0,
                    started_at: None,
                    last_activity_at: None,
                    worktree_prepared: false,
                    event_seq: 0,
                    event_last_status: String::new(),
                    claim_run_id: String::new(),
                    claim_owner: String::new(),
                    claim_lease_expires_at: String::new(),
                    retry_ready_at: String::new(),
                    retry_exhausted_at: String::new(),
                    last_failure_reason: String::new(),
                    last_failure_summary: String::new(),
                    blocked_reason: String::new(),
                    escalation_level: "none".to_string(),
                    escalation_reason: String::new(),
                    last_update: String::new(),
                },
            )]
            .into_iter()
            .collect(),
        };

        let changed =
            recover_transient_nodes(&mut state, &temp_root, false, "2026-03-25T12:00:00Z")
                .expect("recover");
        assert!(changed);
        assert_eq!(state.nodes["OPS-1"].status, "ready_for_review");
    }
}
