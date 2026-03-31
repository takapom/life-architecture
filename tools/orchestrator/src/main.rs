mod runtime_contract;

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{self, Child, Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, SystemTime};

use regex::Regex;
use runtime_contract::{
    ExecutionPlanNode, build_initial_state, normalize_state_shape, read_execution_plan,
    read_gate_results_payload, read_state_payload, recover_transient_nodes,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

fn main() {
    match run(env::args().skip(1).collect()) {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

fn run(args: Vec<String>) -> Result<i32, String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(usage());
    };
    let rest = &args[1..];
    match command {
        "doctor" => run_doctor(rest),
        "run" => run_run(rest),
        "review-decision" => run_review_decision(rest),
        "schedule-retry" => run_schedule_retry(rest),
        "state-bootstrap" => run_state_bootstrap(rest),
        "worktree-classify" => run_worktree_classify(rest),
        "preflight-repo-safety" => run_preflight_repo_safety(rest),
        "repo-safety" => run_repo_safety(rest),
        "validate-pr-url" => run_validate_pr_url(rest),
        "-h" | "--help" | "help" => {
            println!("{}", usage());
            Ok(0)
        }
        other => Err(format!("unknown command: {other}\n\n{}", usage())),
    }
}

fn usage() -> String {
    [
        "Usage:",
        "  omta-orchestrator <command> [options]",
        "",
        "Build or refresh the canonical shared binary first: bun run dev:tools:rust:build",
        "",
        "Commands:",
        "  doctor --repo-root <path> --state-dir <path> --session-id <value> [--state-backend <github|local>] [--allow-dirty-base]",
        "  run --repo-root <path> --state-dir <path> --session-id <value> [--state-backend <github|local>] [--skills-config <path>] [--profile <name>]",
        "  review-decision --state-dir <path> --node-id <value> [--auto-approve] [--merge-queue] [--queue-file <path>]",
        "  schedule-retry --state-dir <path> --node-id <value> --summary <text> --failure-reason <value> --now-iso <timestamp> [--max-retries <n>] [--backoff-base <seconds>] [--backoff-factor <float>] [--backoff-max <seconds>] [--extra-json <json>]",
        "  state-bootstrap --repo-root <path> --state-dir <path> --session-id <value> [--state-backend <github|local>] [--run-issue <number>]",
        "  worktree-classify [--base <branch>] [--include-base]",
        "  preflight-repo-safety [--allow-dirty-base]",
        "  repo-safety --repo-root <path> [--base-branch <branch>] [--allow-dirty-base]",
        "  validate-pr-url <pr_url> [owner/repo]",
    ]
    .join("\n")
}

const TASK_WORKTREE_RUNTIME_CONTRACT: &str = ".tmp/worktree-runtime-contract.json";
const BROKEN_WORKTREE_DIR_MARKER: &str = ".broken-";
const MANAGED_WORKTREE_ROOT_ENV: &str = "ORCHESTRATE_MANAGED_WORKTREE_ROOT";
const UNREGISTERED_DIR_PREVIEW_LIMIT: usize = 6;
const SESSION_ID_PATTERN: &str = r"^[a-z0-9][a-z0-9._-]{5,80}$";

#[derive(Debug)]
struct CmdResult {
    status: i32,
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
struct DoctorOptions {
    repo_root: PathBuf,
    state_dir: PathBuf,
    session_id: String,
    state_backend: String,
    allow_dirty_base: bool,
}

#[derive(Debug)]
struct StateBootstrapOptions {
    repo_root: PathBuf,
    state_dir: PathBuf,
    session_id: String,
    state_backend: String,
    requested_run_issue_number: u64,
    merge_queue_enabled: bool,
}

#[derive(Debug)]
struct ReviewDecisionOptions {
    state_dir: PathBuf,
    node_id: String,
    auto_approve: bool,
    merge_queue_enabled: bool,
    queue_file: Option<PathBuf>,
}

#[derive(Debug)]
struct ScheduleRetryOptions {
    state_dir: PathBuf,
    node_id: String,
    summary: String,
    failure_reason: String,
    now_iso: String,
    max_retries: u64,
    backoff_base: u64,
    backoff_factor: f64,
    backoff_max: u64,
    extra_json: Option<Value>,
}

#[derive(Debug)]
struct RunOptions {
    repo_root: PathBuf,
    state_dir: PathBuf,
    session_id: String,
    state_backend: String,
    skills_config: String,
    profile: String,
}

#[derive(Debug, serde::Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct SkillsConfigRoot {
    orchestrate: Option<OrchestrateSkillConfig>,
}

#[derive(Debug, serde::Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct OrchestrateSkillConfig {
    #[serde(default)]
    default_profile: String,
    #[serde(default)]
    defaults: OrchestrateProfileConfig,
    #[serde(default)]
    profiles: std::collections::BTreeMap<String, OrchestrateProfileConfig>,
}

#[derive(Debug, serde::Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct OrchestrateProfileConfig {
    #[serde(default)]
    spawn_mode: String,
    auto_approve: Option<bool>,
    cleanup: Option<bool>,
    require_passing_tests: Option<bool>,
    require_acceptance_checks: Option<bool>,
    require_worktree_setup: Option<bool>,
    #[serde(default)]
    setup_worktree_cmd: String,
    #[serde(default)]
    child_exec: ChildExecConfig,
    #[serde(default)]
    command_exec: CommandExecConfig,
    #[serde(default)]
    runtime_policy: RuntimePolicyConfig,
    #[serde(default)]
    worktree_gate: WorktreeGateConfig,
    #[serde(default)]
    writing_language: String,
}

#[derive(Debug, serde::Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct ChildExecConfig {
    #[serde(default)]
    cmd: String,
    #[serde(default)]
    args: String,
}

#[derive(Debug, serde::Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct CommandExecConfig {
    #[serde(default)]
    agent_cmd: String,
}

#[derive(Debug, serde::Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct RuntimePolicyConfig {
    max_runtime_seconds: Option<u64>,
    stuck_timeout_seconds: Option<u64>,
}

#[derive(Debug, serde::Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct WorktreeGateConfig {
    enabled: Option<bool>,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    gate_cmd: String,
    fail_on_unmapped_scope: Option<bool>,
    #[serde(default)]
    scope_gate_cmds: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct ResolvedRunConfig {
    spawn_mode: String,
    auto_approve: bool,
    cleanup: bool,
    require_passing_tests: bool,
    require_acceptance_checks: bool,
    require_worktree_setup: bool,
    setup_worktree_cmd: String,
    child_exec_cmd: String,
    child_exec_args: String,
    command_exec_agent_cmd: String,
    max_runtime_seconds: u64,
    stuck_timeout_seconds: u64,
    worktree_gate_enabled: bool,
    worktree_gate_mode: String,
    worktree_gate_cmd: String,
    worktree_scope_gate_cmds: std::collections::BTreeMap<String, String>,
    worktree_fail_on_unmapped_scope: bool,
    writing_language: String,
    selected_profile: String,
}

#[derive(Debug, Serialize, Clone)]
struct RepoSafetySummary {
    repo_root: String,
    base_branch: String,
    managed_worktree_root: String,
    base_worktree_clean: bool,
    base_worktree_detail: String,
    registered_worktree_count: usize,
    invalid_worktree_count: usize,
    invalid_worktrees: Vec<RepoSafetyWorktreeClassification>,
    missing_runtime_contract_worktree_count: usize,
    missing_runtime_contract_worktrees: Vec<MissingRuntimeContractWorktree>,
    unregistered_managed_dir_count: usize,
    unregistered_managed_dirs: Vec<String>,
    unregistered_managed_dir_disposition_counts: DispositionCounts,
    unregistered_managed_dir_classifications: Vec<UnregisteredManagedDirClassification>,
    prunable_worktree_count: usize,
    prunable_worktrees: Vec<PrunableWorktree>,
    blocking_reasons: Vec<BlockingReason>,
    next_action: String,
    recommended_phase: String,
}

#[derive(Debug, Serialize, Clone)]
struct RepoSafetyWorktreeClassification {
    group: String,
    branch: String,
    ahead: i64,
    behind: i64,
    worktree: String,
    merge_reason: String,
}

#[derive(Debug, Serialize, Clone)]
struct BlockingReason {
    code: String,
    detail: String,
}

#[derive(Debug, Serialize, Clone)]
struct PrunableWorktree {
    worktree: String,
    detail: String,
}

#[derive(Debug, Serialize, Clone)]
struct MissingRuntimeContractWorktree {
    worktree: String,
    branch: String,
    contract_path: String,
    detached: bool,
}

#[derive(Debug, Serialize, Clone)]
struct DispositionCounts {
    delete: usize,
    rescue: usize,
    broken_archive: usize,
}

#[derive(Debug, Serialize, Clone)]
struct UnregisteredManagedDirClassification {
    worktree: String,
    dir_name: String,
    disposition: String,
    reason: String,
    git_state: String,
    top_level_entry_count: usize,
    top_level_entries_preview: Vec<String>,
    top_level_entries_overflow_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    gitdir_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scan_error: Option<String>,
}

fn run_command<I, S>(cwd: &Path, program: &str, args: I) -> Result<CmdResult, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("failed to run {program}: {error}"))?;
    Ok(CmdResult {
        status: output.status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn current_repo_root() -> Result<PathBuf, String> {
    let cwd = env::current_dir().map_err(|error| format!("failed to resolve cwd: {error}"))?;
    let result = run_command(&cwd, "git", ["rev-parse", "--show-toplevel"])?;
    if result.status != 0 {
        let detail = command_detail(&result);
        return Err(format!("failed to resolve repository root: {detail}"));
    }
    let repo_root = result.stdout.trim();
    if repo_root.is_empty() {
        return Err("failed to resolve repository root".to_string());
    }
    canonical_dir(Path::new(repo_root))
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path)
        .map_err(|error| format!("failed to canonicalize {}: {error}", path.display()))
}

fn command_detail(result: &CmdResult) -> String {
    let detail = if result.stderr.trim().is_empty() {
        result.stdout.trim().to_string()
    } else {
        result.stderr.trim().to_string()
    };
    if detail.is_empty() {
        format!("exit={}", result.status)
    } else {
        detail
    }
}

fn now_iso_utc() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("failed to format timestamp")
}

fn build_run_id() -> String {
    format!(
        "run_{}_{:08x}",
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
        process::id()
    )
}

fn parse_issue_number(value: &str) -> u64 {
    let text = value.trim();
    if text.is_empty() {
        return 0;
    }
    if let Some(stripped) = text.strip_prefix('#') {
        return stripped.parse::<u64>().unwrap_or(0);
    }
    if let Ok(parsed) = text.parse::<u64>() {
        return parsed;
    }
    Regex::new(r"/issues/([0-9]+)")
        .expect("valid issue url regex")
        .captures(text)
        .and_then(|captures| captures.get(1))
        .and_then(|capture| capture.as_str().parse::<u64>().ok())
        .unwrap_or(0)
}

fn build_github_issue_url(repository: &str, issue_number: u64) -> String {
    format!("https://github.com/{repository}/issues/{issue_number}")
}

fn session_id_pattern() -> &'static Regex {
    static CACHE: OnceLock<Regex> = OnceLock::new();
    CACHE.get_or_init(|| Regex::new(SESSION_ID_PATTERN).expect("invalid session id pattern"))
}

fn parse_doctor_options(args: &[String]) -> Result<DoctorOptions, String> {
    let mut repo_root: Option<PathBuf> = None;
    let mut state_dir = String::new();
    let mut session_id = String::new();
    let mut state_backend = "github".to_string();
    let mut allow_dirty_base = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--repo-root" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--repo-root requires a value".to_string());
                };
                repo_root = Some(PathBuf::from(value));
                index += 2;
            }
            "--state-dir" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-dir requires a value".to_string());
                };
                state_dir = value.clone();
                index += 2;
            }
            "--session-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--session-id requires a value".to_string());
                };
                session_id = value.clone();
                index += 2;
            }
            "--state-backend" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-backend requires a value".to_string());
                };
                state_backend = value.clone();
                index += 2;
            }
            "--allow-dirty-base" => {
                allow_dirty_base = true;
                index += 1;
            }
            "-h" | "--help" => {
                println!(
                    "{}",
                    [
                        "Usage: omta-orchestrator doctor --repo-root <path> --state-dir <path> --session-id <value> [--state-backend <github|local>] [--allow-dirty-base]",
                        "",
                        "Validate canonical non-Python execute doctor preflight requirements from an exported execution plan.",
                    ]
                    .join("\n")
                );
                return Ok(DoctorOptions {
                    repo_root: PathBuf::new(),
                    state_dir: PathBuf::new(),
                    session_id: String::new(),
                    state_backend: String::new(),
                    allow_dirty_base: false,
                });
            }
            other => return Err(format!("unknown option: {other}")),
        }
    }

    let repo_root = if let Some(path) = repo_root {
        path
    } else {
        current_repo_root()?
    };
    if state_dir.trim().is_empty() {
        return Err("--state-dir is required".to_string());
    }
    if session_id.trim().is_empty() {
        return Err("--session-id is required".to_string());
    }
    if state_backend != "github" && state_backend != "local" {
        return Err("--state-backend must be one of: github, local".to_string());
    }

    Ok(DoctorOptions {
        repo_root: canonical_dir(&repo_root)?,
        state_dir: PathBuf::from(state_dir),
        session_id,
        state_backend,
        allow_dirty_base,
    })
}

fn parse_state_bootstrap_options(args: &[String]) -> Result<StateBootstrapOptions, String> {
    let mut repo_root: Option<PathBuf> = None;
    let mut state_dir = String::new();
    let mut session_id = String::new();
    let mut state_backend = "github".to_string();
    let mut requested_run_issue_number = 0;
    let mut merge_queue_enabled = true;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--repo-root" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--repo-root requires a value".to_string());
                };
                repo_root = Some(PathBuf::from(value));
                index += 2;
            }
            "--state-dir" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-dir requires a value".to_string());
                };
                state_dir = value.clone();
                index += 2;
            }
            "--session-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--session-id requires a value".to_string());
                };
                session_id = value.clone();
                index += 2;
            }
            "--state-backend" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-backend requires a value".to_string());
                };
                state_backend = value.clone();
                index += 2;
            }
            "--run-issue" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--run-issue requires a value".to_string());
                };
                requested_run_issue_number = parse_issue_number(value);
                index += 2;
            }
            "--merge-queue" => {
                merge_queue_enabled = true;
                index += 1;
            }
            "--no-merge-queue" => {
                merge_queue_enabled = false;
                index += 1;
            }
            other => return Err(format!("unknown option: {other}")),
        }
    }
    if state_dir.trim().is_empty() {
        return Err("--state-dir is required".to_string());
    }
    if session_id.trim().is_empty() {
        return Err("--session-id is required".to_string());
    }
    if !session_id_pattern().is_match(session_id.trim()) {
        return Err(format!("invalid session id: {session_id}"));
    }
    if state_backend != "github" && state_backend != "local" {
        return Err("--state-backend must be one of: github, local".to_string());
    }
    Ok(StateBootstrapOptions {
        repo_root: canonical_dir(&repo_root.unwrap_or(current_repo_root()?))?,
        state_dir: PathBuf::from(state_dir),
        session_id,
        state_backend,
        requested_run_issue_number,
        merge_queue_enabled,
    })
}

fn parse_run_options(args: &[String]) -> Result<RunOptions, String> {
    let mut repo_root: Option<PathBuf> = None;
    let mut state_dir = String::new();
    let mut session_id = String::new();
    let mut state_backend = "github".to_string();
    let mut skills_config = String::new();
    let mut profile = String::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--repo-root" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--repo-root requires a value".to_string());
                };
                repo_root = Some(PathBuf::from(value));
                index += 2;
            }
            "--state-dir" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-dir requires a value".to_string());
                };
                state_dir = value.clone();
                index += 2;
            }
            "--session-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--session-id requires a value".to_string());
                };
                session_id = value.clone();
                index += 2;
            }
            "--state-backend" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-backend requires a value".to_string());
                };
                state_backend = value.clone();
                index += 2;
            }
            "--skills-config" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--skills-config requires a value".to_string());
                };
                skills_config = value.clone();
                index += 2;
            }
            "--profile" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--profile requires a value".to_string());
                };
                profile = value.clone();
                index += 2;
            }
            other => return Err(format!("unknown option: {other}")),
        }
    }
    if state_dir.trim().is_empty() {
        return Err("--state-dir is required".to_string());
    }
    if session_id.trim().is_empty() {
        return Err("--session-id is required".to_string());
    }
    if !session_id_pattern().is_match(session_id.trim()) {
        return Err(format!("invalid session id: {session_id}"));
    }
    if state_backend != "github" && state_backend != "local" {
        return Err("--state-backend must be one of: github, local".to_string());
    }
    Ok(RunOptions {
        repo_root: canonical_dir(&repo_root.unwrap_or(current_repo_root()?))?,
        state_dir: PathBuf::from(state_dir),
        session_id,
        state_backend,
        skills_config,
        profile,
    })
}

fn parse_review_decision_options(args: &[String]) -> Result<ReviewDecisionOptions, String> {
    let mut state_dir = String::new();
    let mut node_id = String::new();
    let mut auto_approve = false;
    let mut merge_queue_enabled = false;
    let mut queue_file: Option<PathBuf> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--state-dir" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-dir requires a value".to_string());
                };
                state_dir = value.clone();
                index += 2;
            }
            "--node-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--node-id requires a value".to_string());
                };
                node_id = value.clone();
                index += 2;
            }
            "--queue-file" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--queue-file requires a value".to_string());
                };
                queue_file = Some(PathBuf::from(value));
                index += 2;
            }
            "--auto-approve" => {
                auto_approve = true;
                index += 1;
            }
            "--merge-queue" => {
                merge_queue_enabled = true;
                index += 1;
            }
            other => return Err(format!("unknown option: {other}")),
        }
    }
    if state_dir.trim().is_empty() {
        return Err("--state-dir is required".to_string());
    }
    if node_id.trim().is_empty() {
        return Err("--node-id is required".to_string());
    }
    Ok(ReviewDecisionOptions {
        state_dir: PathBuf::from(state_dir),
        node_id,
        auto_approve,
        merge_queue_enabled,
        queue_file,
    })
}

fn parse_schedule_retry_options(args: &[String]) -> Result<ScheduleRetryOptions, String> {
    let mut state_dir = String::new();
    let mut node_id = String::new();
    let mut summary = String::new();
    let mut failure_reason = String::new();
    let mut now_iso = String::new();
    let mut max_retries = 0_u64;
    let mut backoff_base = 0_u64;
    let mut backoff_factor = 0_f64;
    let mut backoff_max = 0_u64;
    let mut extra_json: Option<Value> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--state-dir" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--state-dir requires a value".to_string());
                };
                state_dir = value.clone();
                index += 2;
            }
            "--node-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--node-id requires a value".to_string());
                };
                node_id = value.clone();
                index += 2;
            }
            "--summary" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--summary requires a value".to_string());
                };
                summary = value.clone();
                index += 2;
            }
            "--failure-reason" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--failure-reason requires a value".to_string());
                };
                failure_reason = value.clone();
                index += 2;
            }
            "--now-iso" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--now-iso requires a value".to_string());
                };
                now_iso = value.clone();
                index += 2;
            }
            "--max-retries" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--max-retries requires a value".to_string());
                };
                max_retries = value
                    .parse::<u64>()
                    .map_err(|error| format!("invalid --max-retries value: {error}"))?;
                index += 2;
            }
            "--backoff-base" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--backoff-base requires a value".to_string());
                };
                backoff_base = value
                    .parse::<u64>()
                    .map_err(|error| format!("invalid --backoff-base value: {error}"))?;
                index += 2;
            }
            "--backoff-factor" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--backoff-factor requires a value".to_string());
                };
                backoff_factor = value
                    .parse::<f64>()
                    .map_err(|error| format!("invalid --backoff-factor value: {error}"))?;
                index += 2;
            }
            "--backoff-max" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--backoff-max requires a value".to_string());
                };
                backoff_max = value
                    .parse::<u64>()
                    .map_err(|error| format!("invalid --backoff-max value: {error}"))?;
                index += 2;
            }
            "--extra-json" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--extra-json requires a value".to_string());
                };
                let parsed: Value = serde_json::from_str(value)
                    .map_err(|error| format!("invalid --extra-json payload: {error}"))?;
                if !parsed.is_object() {
                    return Err("--extra-json must be a JSON object".to_string());
                }
                extra_json = Some(parsed);
                index += 2;
            }
            other => return Err(format!("unknown option: {other}")),
        }
    }
    if state_dir.trim().is_empty() {
        return Err("--state-dir is required".to_string());
    }
    if node_id.trim().is_empty() {
        return Err("--node-id is required".to_string());
    }
    if summary.trim().is_empty() {
        return Err("--summary is required".to_string());
    }
    if now_iso.trim().is_empty() {
        return Err("--now-iso is required".to_string());
    }
    Ok(ScheduleRetryOptions {
        state_dir: PathBuf::from(state_dir),
        node_id,
        summary,
        failure_reason,
        now_iso,
        max_retries,
        backoff_base,
        backoff_factor,
        backoff_max,
        extra_json,
    })
}

fn run_doctor(args: &[String]) -> Result<i32, String> {
    let options = parse_doctor_options(args)?;
    if options.repo_root.as_os_str().is_empty() && options.state_dir.as_os_str().is_empty() {
        return Ok(0);
    }

    let execution_plan_path = options.state_dir.join("inputs").join("execution-plan.json");
    let execution_plan = read_execution_plan(&execution_plan_path)?;
    let base_branch = execution_plan.base_branch.clone();
    let merge_mode = execution_plan.merge_mode.clone();
    let nodes = execution_plan
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node.branch.clone()))
        .collect::<Vec<_>>();
    let issue_tracking_repository = execution_plan.issue_tracking.repository.clone();

    let mut checks: Vec<(String, bool, String)> = Vec::new();
    let base_ref = run_command(
        &options.repo_root,
        "git",
        ["rev-parse", "--verify", &base_branch],
    )?;
    checks.push((
        "base_branch".to_string(),
        base_ref.status == 0,
        base_branch.clone(),
    ));
    checks.push((
        "orchestrate_session_id".to_string(),
        session_id_pattern().is_match(options.session_id.trim()),
        options.session_id.clone(),
    ));

    let (base_reservation_ok, base_reservation_detail) =
        evaluate_base_worktree_reservation(&options.repo_root)?;
    checks.push((
        "base_worktree_reservation".to_string(),
        base_reservation_ok,
        base_reservation_detail,
    ));

    let (invocation_ok, invocation_detail) =
        evaluate_orchestrator_invocation_worktree(&options.repo_root)?;
    checks.push((
        "invocation_worktree".to_string(),
        invocation_ok,
        invocation_detail,
    ));

    let (base_clean_ok, base_clean_detail) = evaluate_base_worktree_clean(&options.repo_root)?;
    let base_clean_status = base_clean_ok || options.allow_dirty_base;
    let base_clean_detail = if base_clean_ok {
        base_clean_detail
    } else if options.allow_dirty_base {
        format!("bypassed via allow_dirty_base: {base_clean_detail}")
    } else {
        base_clean_detail
    };
    checks.push((
        "base_worktree_clean".to_string(),
        base_clean_status,
        base_clean_detail,
    ));

    let repo_safety_summary =
        inspect_repo_safety_summary(&options.repo_root, &base_branch, options.allow_dirty_base)?;
    let repo_safety_ok = repo_safety_summary.recommended_phase == "execute";
    checks.push((
        "repo_safety_state".to_string(),
        repo_safety_ok,
        format_repo_safety_detail_from_summary(&repo_safety_summary),
    ));

    let (template_sot_ok, template_sot_detail) = evaluate_template_sot_files(&options.repo_root);
    checks.push((
        "template_sot_files".to_string(),
        template_sot_ok,
        template_sot_detail,
    ));

    if merge_mode == "remote-pr" {
        let (preflight_ok, preflight_detail) = run_remote_pr_preflight(&options.repo_root)?;
        checks.push((
            "remote_pr_preflight".to_string(),
            preflight_ok,
            preflight_detail,
        ));
    }

    let merge_head_clean = resolve_merge_head_clean(&options.repo_root)?;
    checks.push((
        "merge_state_clean".to_string(),
        merge_head_clean.0,
        merge_head_clean.1,
    ));

    let unique_branches_ok = branches_are_unique(&nodes);
    checks.push((
        "unique_branches".to_string(),
        unique_branches_ok,
        "all node branches must be unique".to_string(),
    ));

    let worktree_root = resolve_session_worktree_root(&options.repo_root, &options.session_id)?;
    let unique_paths_ok = node_worktree_paths_are_unique(&worktree_root, &nodes);
    checks.push((
        "session_worktree_paths".to_string(),
        unique_paths_ok,
        "active executor worktrees must stay unique under the session worktree root".to_string(),
    ));

    let attached_worktrees =
        attached_executor_worktrees(&options.repo_root, &worktree_root, &nodes)?;
    checks.push((
        "executor_worktrees_detached".to_string(),
        attached_worktrees.is_empty(),
        if attached_worktrees.is_empty() {
            "all executor worktrees detached".to_string()
        } else {
            attached_worktrees.join(", ")
        },
    ));

    checks.push((
        "state_backend".to_string(),
        options.state_backend == "github" || options.state_backend == "local",
        options.state_backend.clone(),
    ));
    if options.state_backend == "github" {
        checks.push((
            "github_issue_tracking_repository".to_string(),
            !issue_tracking_repository.trim().is_empty(),
            if issue_tracking_repository.trim().is_empty() {
                "(missing)".to_string()
            } else {
                issue_tracking_repository
            },
        ));
        checks.push((
            "gh_cli_available".to_string(),
            command_exists("gh"),
            which_like("gh").unwrap_or_else(|| "(missing)".to_string()),
        ));
    }

    println!("Doctor checks:");
    let mut has_failure = false;
    for (name, ok, detail) in checks {
        let status = if ok { "ok" } else { "fail" };
        println!("- [{status}] {name}: {detail}");
        if !ok {
            has_failure = true;
        }
    }

    if has_failure {
        return Ok(2);
    }
    println!("Doctor checks passed");
    Ok(0)
}

fn run_state_bootstrap(args: &[String]) -> Result<i32, String> {
    let options = parse_state_bootstrap_options(args)?;
    let state_dir = canonical_or_existing_path(&options.state_dir)?;
    let execution_plan_path = state_dir.join("inputs").join("execution-plan.json");
    let execution_plan = read_execution_plan(&execution_plan_path)?;
    let state_path = state_dir.join("state.json");
    let now_iso = now_iso_utc();

    let mut state = if state_path.is_file() {
        read_state_payload(&state_path)?
    } else {
        build_initial_state(&execution_plan.nodes, &now_iso)
    };
    normalize_state_shape(&mut state, &execution_plan.nodes, &now_iso);
    let worktree_root = resolve_session_worktree_root(&options.repo_root, &options.session_id)?;
    state.runtime.session_id = options.session_id.clone();
    state.runtime.worktree_root = worktree_root.display().to_string();
    state.runtime.worktree_root_source = "session-default".to_string();
    state.runtime.repo_root = options.repo_root.display().to_string();
    state.github_state.state_backend = options.state_backend.clone();
    state.github_state.repository = execution_plan.issue_tracking.repository.clone();
    if state.github_state.initialized_at.trim().is_empty() {
        state.github_state.initialized_at = now_iso.clone();
    }
    if options.state_backend == "github" {
        if state.github_state.run_id.trim().is_empty() {
            state.github_state.run_id = build_run_id();
        }
        let resolved_run_issue_number = if options.requested_run_issue_number > 0 {
            options.requested_run_issue_number
        } else if state.github_state.run_issue_number > 0 {
            state.github_state.run_issue_number
        } else if parse_issue_number(&state.github_state.run_issue_url) > 0 {
            parse_issue_number(&state.github_state.run_issue_url)
        } else {
            execution_plan.issue_tracking.progress_issue_number
        };
        state.github_state.run_issue_number = resolved_run_issue_number;
        state.github_state.run_issue_url = if resolved_run_issue_number > 0 {
            build_github_issue_url(&state.github_state.repository, resolved_run_issue_number)
        } else {
            String::new()
        };
    } else {
        state.github_state.run_id.clear();
        state.github_state.run_issue_number = 0;
        state.github_state.run_issue_url.clear();
    }
    recover_transient_nodes(
        &mut state,
        &state_dir,
        options.merge_queue_enabled,
        &now_iso,
    )?;
    state.updated_at = now_iso;

    fs::create_dir_all(&state_dir)
        .map_err(|error| format!("failed to create {}: {error}", state_dir.display()))?;
    fs::write(
        &state_path,
        serde_json::to_string_pretty(&state)
            .map_err(|error| format!("failed to serialize {}: {error}", state_path.display()))?
            + "\n",
    )
    .map_err(|error| format!("failed to write {}: {error}", state_path.display()))?;
    println!("{}", state_path.display());
    Ok(0)
}

fn run_review_decision(args: &[String]) -> Result<i32, String> {
    let options = parse_review_decision_options(args)?;
    let state_dir = canonical_or_existing_path(&options.state_dir)?;
    let state_path = state_dir.join("state.json");
    let mut state = read_json_value(&state_path)?;
    let state_obj = ensure_object_mut(&mut state, "state")?;
    let nodes_value = state_obj
        .get_mut("nodes")
        .ok_or_else(|| format!("state.nodes is required: {}", state_path.display()))?;
    let nodes = ensure_object_mut(nodes_value, "state.nodes")?;
    let node_value = nodes
        .get_mut(&options.node_id)
        .ok_or_else(|| format!("missing state node: {}", options.node_id))?;
    let node = ensure_object_mut(node_value, &format!("state.nodes.{}", options.node_id))?;

    let review_path = canonical_review_path(&state_dir, &options.node_id);
    let review = if review_path.is_file() {
        parse_review_artifact_value(&read_json_value(&review_path)?, &options.node_id)?
    } else if options.auto_approve {
        let review = build_auto_approve_review_value(&options.node_id);
        write_json_value(&review_path, &review)?;
        review
    } else {
        println!("{}", json!({ "decision": "" }));
        return Ok(0);
    };

    let decision = review
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let now_iso = now_iso_utc();
    let queue_path = options
        .queue_file
        .clone()
        .unwrap_or_else(|| state_dir.join("merge-queue.json"));
    let mut queue = if queue_path.is_file() {
        let value = read_json_value(&queue_path)?;
        value
            .as_array()
            .cloned()
            .ok_or_else(|| format!("queue file must be a list: {}", queue_path.display()))?
    } else {
        Vec::new()
    };

    match decision.as_str() {
        "rework" => {
            let attempts = node.get("attempts").and_then(Value::as_u64).unwrap_or(0) + 1;
            node.insert("status".to_string(), Value::String("pending".to_string()));
            node.insert("attempts".to_string(), Value::from(attempts));
            node.insert(
                "last_failure_reason".to_string(),
                Value::String("review_rework_requested".to_string()),
            );
            node.insert(
                "last_failure_summary".to_string(),
                Value::String(
                    review
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("review requested rework")
                        .trim()
                        .to_string(),
                ),
            );
            node.insert("retry_ready_at".to_string(), Value::String(String::new()));
            node.insert(
                "retry_exhausted_at".to_string(),
                Value::String(String::new()),
            );
            node.insert("blocked_reason".to_string(), Value::String(String::new()));
            node.insert(
                "escalation_level".to_string(),
                Value::String("none".to_string()),
            );
            node.insert(
                "escalation_reason".to_string(),
                Value::String(String::new()),
            );
            node.insert("last_update".to_string(), Value::String(now_iso.clone()));
            clear_review_iteration_artifacts(&state_dir, &options.node_id)?;
            if options.merge_queue_enabled {
                queue.retain(|item| {
                    item.get("node_id").and_then(Value::as_str) != Some(options.node_id.as_str())
                });
                write_json_value(&queue_path, &Value::Array(queue.clone()))?;
            }
        }
        "reject" => {
            let review_summary = review
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("review rejected")
                .trim()
                .to_string();
            let escalation = review
                .get("escalation")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let escalation_level = escalation
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("manual")
                .trim()
                .to_string();
            let escalation_reason = escalation
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            write_blocked_status_value(
                &state_dir,
                &options.node_id,
                &review_summary,
                "review_rejected",
                &review,
            )?;
            node.insert("status".to_string(), Value::String("blocked".to_string()));
            node.insert(
                "blocked_reason".to_string(),
                Value::String("review_rejected".to_string()),
            );
            node.insert(
                "last_failure_reason".to_string(),
                Value::String("review_rejected".to_string()),
            );
            node.insert(
                "last_failure_summary".to_string(),
                Value::String(review_summary.clone()),
            );
            node.insert("retry_ready_at".to_string(), Value::String(String::new()));
            node.insert(
                "retry_exhausted_at".to_string(),
                Value::String(String::new()),
            );
            node.insert(
                "escalation_level".to_string(),
                Value::String(if escalation_level.is_empty() {
                    "manual".to_string()
                } else {
                    escalation_level
                }),
            );
            node.insert(
                "escalation_reason".to_string(),
                Value::String(if escalation_reason.is_empty() {
                    review_summary
                } else {
                    escalation_reason.to_string()
                }),
            );
            node.insert("last_update".to_string(), Value::String(now_iso.clone()));
        }
        "approve" => {}
        _ => {
            write_failed_status_value(
                &state_dir,
                &options.node_id,
                &format!("review gate failed: unsupported decision '{}'", decision),
                "review_decision_invalid",
            )?;
            node.insert("status".to_string(), Value::String("failed".to_string()));
            node.insert(
                "last_failure_reason".to_string(),
                Value::String("review_decision_invalid".to_string()),
            );
            node.insert(
                "last_failure_summary".to_string(),
                Value::String(format!("unsupported review decision: {}", decision)),
            );
            node.insert("retry_ready_at".to_string(), Value::String(String::new()));
            node.insert(
                "retry_exhausted_at".to_string(),
                Value::String(String::new()),
            );
            node.insert(
                "escalation_level".to_string(),
                Value::String("manual".to_string()),
            );
            node.insert(
                "escalation_reason".to_string(),
                Value::String("review_decision_invalid".to_string()),
            );
            node.insert("last_update".to_string(), Value::String(now_iso.clone()));
        }
    }

    state_obj.insert("updated_at".to_string(), Value::String(now_iso));
    write_json_value(&state_path, &state)?;
    println!(
        "{}",
        json!({
            "decision": decision,
            "state_path": state_path.display().to_string(),
            "queue_path": queue_path.display().to_string(),
        })
    );
    Ok(0)
}

fn run_schedule_retry(args: &[String]) -> Result<i32, String> {
    let options = parse_schedule_retry_options(args)?;
    let state_dir = canonical_or_existing_path(&options.state_dir)?;
    let state_path = state_dir.join("state.json");
    let mut state = read_json_value(&state_path)?;
    let state_obj = ensure_object_mut(&mut state, "state")?;
    let nodes_value = state_obj
        .get_mut("nodes")
        .ok_or_else(|| format!("state.nodes is required: {}", state_path.display()))?;
    let nodes = ensure_object_mut(nodes_value, "state.nodes")?;
    let node_value = nodes
        .get_mut(&options.node_id)
        .ok_or_else(|| format!("missing state node: {}", options.node_id))?;
    let node = ensure_object_mut(node_value, &format!("state.nodes.{}", options.node_id))?;

    let reason_text = if options.failure_reason.trim().is_empty() {
        "orchestrator_failed".to_string()
    } else {
        options.failure_reason.trim().to_string()
    };
    let summary_text = if options.summary.trim().is_empty() {
        reason_text.clone()
    } else {
        options.summary.trim().to_string()
    };
    let attempts = node.get("attempts").and_then(Value::as_u64).unwrap_or(0) + 1;
    node.insert("attempts".to_string(), Value::from(attempts));
    node.insert(
        "last_failure_reason".to_string(),
        Value::String(reason_text.clone()),
    );
    node.insert(
        "last_failure_summary".to_string(),
        Value::String(summary_text.clone()),
    );
    node.insert("blocked_reason".to_string(), Value::String(String::new()));
    node.insert(
        "last_update".to_string(),
        Value::String(options.now_iso.clone()),
    );
    node.insert("started_at".to_string(), Value::Null);
    node.insert("last_activity_at".to_string(), Value::Null);

    let exhausted = options.max_retries > 0 && attempts >= options.max_retries;
    if exhausted {
        node.insert("status".to_string(), Value::String("blocked".to_string()));
        node.insert("retry_ready_at".to_string(), Value::String(String::new()));
        node.insert(
            "retry_exhausted_at".to_string(),
            Value::String(options.now_iso.clone()),
        );
        node.insert(
            "blocked_reason".to_string(),
            Value::String(reason_text.clone()),
        );
        node.insert(
            "escalation_level".to_string(),
            Value::String("manual".to_string()),
        );
        node.insert(
            "escalation_reason".to_string(),
            Value::String(format!(
                "retry budget exhausted after {attempts} attempts ({reason_text})"
            )),
        );
        let mut extra = options
            .extra_json
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        extra.insert(
            "retry".to_string(),
            json!({
                "attempts": attempts,
                "max_retries": options.max_retries,
                "exhausted": true,
            }),
        );
        write_blocked_status_with_extra_value(
            &state_dir,
            &options.node_id,
            &summary_text,
            &reason_text,
            &Value::Object(extra),
        )?;
    } else {
        let next_attempt = retry_ready_at(
            &options.now_iso,
            attempts,
            options.backoff_base,
            options.backoff_factor,
            options.backoff_max,
        )?;
        node.insert("status".to_string(), Value::String("pending".to_string()));
        node.insert("retry_ready_at".to_string(), Value::String(next_attempt));
        node.insert(
            "retry_exhausted_at".to_string(),
            Value::String(String::new()),
        );
        node.insert(
            "escalation_level".to_string(),
            Value::String("none".to_string()),
        );
        node.insert(
            "escalation_reason".to_string(),
            Value::String(String::new()),
        );
        clear_review_iteration_artifacts(&state_dir, &options.node_id)?;
    }

    state_obj.insert("updated_at".to_string(), Value::String(options.now_iso));
    write_json_value(&state_path, &state)?;
    println!(
        "{}",
        json!({
            "retry_scheduled": !exhausted,
            "state_path": state_path.display().to_string(),
        })
    );
    Ok(0)
}

fn default_skills_config_path(repo_root: &Path) -> PathBuf {
    repo_root
        .join("tools")
        .join("orchestrator")
        .join("orchestrate")
        .join("skills.config.toml")
}

fn load_resolved_run_config(options: &RunOptions) -> Result<ResolvedRunConfig, String> {
    let config_path = if options.skills_config.trim().is_empty() {
        default_skills_config_path(&options.repo_root)
    } else {
        canonical_or_existing_path(Path::new(options.skills_config.trim()))?
    };
    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("failed to read {}: {error}", config_path.display()))?;
    let parsed: SkillsConfigRoot = if config_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("json")
    {
        serde_json::from_str(&raw)
            .map_err(|error| format!("failed to parse {}: {error}", config_path.display()))?
    } else {
        toml::from_str(&raw)
            .map_err(|error| format!("failed to parse {}: {error}", config_path.display()))?
    };
    let orchestrate = parsed
        .orchestrate
        .ok_or_else(|| format!("orchestrate section is required: {}", config_path.display()))?;
    let selected_profile = if options.profile.trim().is_empty() {
        orchestrate.default_profile.trim().to_string()
    } else {
        options.profile.trim().to_string()
    };
    let mut merged = orchestrate.defaults.clone();
    if !selected_profile.is_empty() {
        let profile = orchestrate.profiles.get(&selected_profile).ok_or_else(|| {
            format!(
                "unknown orchestrate profile '{}' in {}",
                selected_profile,
                config_path.display()
            )
        })?;
        merge_profile_config(&mut merged, profile);
    }
    Ok(ResolvedRunConfig {
        spawn_mode: if merged.spawn_mode.trim().is_empty() {
            "child-exec".to_string()
        } else {
            merged.spawn_mode.trim().to_string()
        },
        auto_approve: merged.auto_approve.unwrap_or(false),
        cleanup: merged.cleanup.unwrap_or(true),
        require_passing_tests: merged.require_passing_tests.unwrap_or(true),
        require_acceptance_checks: merged.require_acceptance_checks.unwrap_or(true),
        require_worktree_setup: merged.require_worktree_setup.unwrap_or(false),
        setup_worktree_cmd: merged.setup_worktree_cmd.trim().to_string(),
        child_exec_cmd: merged.child_exec.cmd.trim().to_string(),
        child_exec_args: merged.child_exec.args.trim().to_string(),
        command_exec_agent_cmd: merged.command_exec.agent_cmd.trim().to_string(),
        max_runtime_seconds: merged.runtime_policy.max_runtime_seconds.unwrap_or(3600),
        stuck_timeout_seconds: merged.runtime_policy.stuck_timeout_seconds.unwrap_or(300),
        worktree_gate_enabled: merged.worktree_gate.enabled.unwrap_or(false),
        worktree_gate_mode: if merged.worktree_gate.mode.trim().is_empty() {
            "global".to_string()
        } else {
            merged.worktree_gate.mode.trim().to_string()
        },
        worktree_gate_cmd: merged.worktree_gate.gate_cmd.trim().to_string(),
        worktree_scope_gate_cmds: merged.worktree_gate.scope_gate_cmds.clone(),
        worktree_fail_on_unmapped_scope: merged
            .worktree_gate
            .fail_on_unmapped_scope
            .unwrap_or(true),
        writing_language: if merged.writing_language.trim().is_empty() {
            "ja".to_string()
        } else {
            merged.writing_language.trim().to_string()
        },
        selected_profile,
    })
}

fn merge_profile_config(base: &mut OrchestrateProfileConfig, overlay: &OrchestrateProfileConfig) {
    if !overlay.spawn_mode.trim().is_empty() {
        base.spawn_mode = overlay.spawn_mode.clone();
    }
    if overlay.auto_approve.is_some() {
        base.auto_approve = overlay.auto_approve;
    }
    if overlay.cleanup.is_some() {
        base.cleanup = overlay.cleanup;
    }
    if overlay.require_passing_tests.is_some() {
        base.require_passing_tests = overlay.require_passing_tests;
    }
    if overlay.require_acceptance_checks.is_some() {
        base.require_acceptance_checks = overlay.require_acceptance_checks;
    }
    if overlay.require_worktree_setup.is_some() {
        base.require_worktree_setup = overlay.require_worktree_setup;
    }
    if !overlay.setup_worktree_cmd.trim().is_empty() {
        base.setup_worktree_cmd = overlay.setup_worktree_cmd.clone();
    }
    if !overlay.child_exec.cmd.trim().is_empty() {
        base.child_exec.cmd = overlay.child_exec.cmd.clone();
    }
    if !overlay.child_exec.args.trim().is_empty() {
        base.child_exec.args = overlay.child_exec.args.clone();
    }
    if !overlay.command_exec.agent_cmd.trim().is_empty() {
        base.command_exec.agent_cmd = overlay.command_exec.agent_cmd.clone();
    }
    if overlay.runtime_policy.max_runtime_seconds.is_some() {
        base.runtime_policy.max_runtime_seconds = overlay.runtime_policy.max_runtime_seconds;
    }
    if overlay.runtime_policy.stuck_timeout_seconds.is_some() {
        base.runtime_policy.stuck_timeout_seconds = overlay.runtime_policy.stuck_timeout_seconds;
    }
    if overlay.worktree_gate.enabled.is_some() {
        base.worktree_gate.enabled = overlay.worktree_gate.enabled;
    }
    if !overlay.worktree_gate.mode.trim().is_empty() {
        base.worktree_gate.mode = overlay.worktree_gate.mode.clone();
    }
    if !overlay.worktree_gate.gate_cmd.trim().is_empty() {
        base.worktree_gate.gate_cmd = overlay.worktree_gate.gate_cmd.clone();
    }
    if overlay.worktree_gate.fail_on_unmapped_scope.is_some() {
        base.worktree_gate.fail_on_unmapped_scope = overlay.worktree_gate.fail_on_unmapped_scope;
    }
    if !overlay.worktree_gate.scope_gate_cmds.is_empty() {
        base.worktree_gate.scope_gate_cmds = overlay.worktree_gate.scope_gate_cmds.clone();
    }
    if !overlay.writing_language.trim().is_empty() {
        base.writing_language = overlay.writing_language.clone();
    }
}

fn worktree_status_path(worktree_path: &Path, node_id: &str) -> PathBuf {
    worktree_path
        .join(".orchestrator")
        .join("status")
        .join(format!("{node_id}.json"))
}

fn gate_results_path(state_dir: &Path) -> PathBuf {
    state_dir.join("gate-results.json")
}

fn task_file_path(state_dir: &Path, node_id: &str) -> PathBuf {
    state_dir.join("tasks").join(format!("{node_id}.md"))
}

fn read_json_value_if_exists(path: &Path) -> Result<Option<Value>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(read_json_value(path)?))
}

fn node_object_mut<'a>(
    state: &'a mut Value,
    node_id: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    let state_obj = ensure_object_mut(state, "state")?;
    let nodes_value = state_obj
        .get_mut("nodes")
        .ok_or_else(|| "state.nodes is required".to_string())?;
    let nodes = ensure_object_mut(nodes_value, "state.nodes")?;
    let node_value = nodes
        .get_mut(node_id)
        .ok_or_else(|| format!("missing state node: {node_id}"))?;
    ensure_object_mut(node_value, &format!("state.nodes.{node_id}"))
}

fn node_object<'a>(
    state: &'a Value,
    node_id: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    state
        .as_object()
        .and_then(|object| object.get("nodes"))
        .and_then(Value::as_object)
        .and_then(|nodes| nodes.get(node_id))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("missing state node: {node_id}"))
}

fn node_status(state: &Value, node_id: &str) -> Result<String, String> {
    Ok(node_object(state, node_id)?
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string())
}

fn write_gate_results_single_node(
    state_dir: &Path,
    state: &Value,
    node: &ExecutionPlanNode,
    auto_approve: bool,
) -> Result<(), String> {
    let node_state = node_object(state, &node.id)?;
    let status_path = canonical_status_path(state_dir, &node.id);
    let review_path = canonical_review_path(state_dir, &node.id);
    let conflict_path = state_dir.join("conflict").join(format!("{}.json", node.id));
    let status_payload = read_json_value_if_exists(&status_path)?.unwrap_or(Value::Null);
    let summary = status_payload
        .as_object()
        .and_then(|value| value.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            node_state
                .get("last_failure_summary")
                .and_then(Value::as_str)
                .unwrap_or("")
        })
        .trim()
        .to_string();
    let failure_reason = status_payload
        .as_object()
        .and_then(|value| value.get("failure_reason"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            node_state
                .get("last_failure_reason")
                .and_then(Value::as_str)
                .unwrap_or("")
        })
        .trim()
        .to_string();
    let pr_url = status_payload
        .as_object()
        .and_then(|value| value.get("pr_url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let generated_at = now_iso_utc();
    let state_updated_at = state
        .as_object()
        .and_then(|value| value.get("updated_at"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let payload = json!({
        "generated_at": generated_at,
        "state_updated_at": state_updated_at,
        "dispatch": {
            "review_policy": {
                "mode": if auto_approve { "auto" } else { "manual" },
                "auto_approve": auto_approve,
            },
            "ready_candidates": if node_state.get("status").and_then(Value::as_str).unwrap_or("") == "pending" { vec![node.id.clone()] } else { Vec::<String>::new() },
        },
        "nodes": [{
            "node_id": node.id,
            "status": node_state.get("status").and_then(Value::as_str).unwrap_or("pending"),
            "branch": node.branch,
            "summary": summary,
            "failure_reason": failure_reason,
            "pr_url": pr_url,
            "artifacts": {
                "status_json": if status_path.is_file() { format!("status/{}.json", node.id) } else { String::new() },
                "conflict_json": if conflict_path.is_file() { format!("conflict/{}.json", node.id) } else { String::new() },
                "review_json": if review_path.is_file() { format!("review/{}.json", node.id) } else { String::new() },
            }
        }]
    });
    let gate_results = gate_results_path(state_dir);
    write_json_value(&gate_results, &payload)?;
    let _ = read_gate_results_payload(&gate_results)?;
    Ok(())
}

fn persist_runtime_artifacts(
    state_path: &Path,
    state: &mut Value,
    state_dir: &Path,
    node: &ExecutionPlanNode,
    auto_approve: bool,
) -> Result<(), String> {
    let now_iso = now_iso_utc();
    let state_obj = ensure_object_mut(state, "state")?;
    state_obj.insert("updated_at".to_string(), Value::String(now_iso));
    write_json_value(state_path, state)?;
    write_gate_results_single_node(state_dir, state, node, auto_approve)
}

fn shell_words(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn ensure_managed_worktree(
    repo_root: &Path,
    worktree_root: &Path,
    node: &ExecutionPlanNode,
    base_branch: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(worktree_root)
        .map_err(|error| format!("failed to create {}: {error}", worktree_root.display()))?;
    let worktree_path = worktree_root.join(&node.id);
    if !worktree_path.exists() {
        let args = vec![
            "worktree".to_string(),
            "add".to_string(),
            "--force".to_string(),
            "--detach".to_string(),
            worktree_path.display().to_string(),
            base_branch.to_string(),
        ];
        let result = run_command(repo_root, "git", &args)?;
        if result.status != 0 {
            return Err(format!(
                "failed to create worktree {}: {}",
                worktree_path.display(),
                command_detail(&result)
            ));
        }
    }
    let contract_path = worktree_path.join(TASK_WORKTREE_RUNTIME_CONTRACT);
    if let Some(parent) = contract_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    write_json_value(
        &contract_path,
        &json!({
            "session_id": session_id,
            "node_id": node.id,
            "branch": node.branch,
            "base_branch": base_branch,
            "repo_root": repo_root.display().to_string(),
            "worktree": worktree_path.display().to_string(),
            "rendered_at": now_iso_utc(),
        }),
    )?;
    fs::create_dir_all(worktree_path.join(".orchestrator").join("status"))
        .map_err(|error| format!("failed to prepare worktree status dir: {error}"))?;
    Ok(worktree_path)
}

fn render_task_prompt(
    repo_root: &Path,
    worktree_path: &Path,
    node: &ExecutionPlanNode,
    base_branch: &str,
    config: &ResolvedRunConfig,
) -> String {
    let allowed_files = if node.allowed_files.is_empty() {
        "- (not restricted)".to_string()
    } else {
        node.allowed_files
            .iter()
            .map(|entry| format!("- {entry}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let acceptance_checks = if node.acceptance_checks.is_empty() {
        "- (none)".to_string()
    } else {
        node.acceptance_checks
            .iter()
            .map(|entry| format!("- {entry}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let tests = if node.tests.is_empty() {
        "- (none)".to_string()
    } else {
        node.tests
            .iter()
            .map(|entry| format!("- {entry}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let issue_line = if node.github_issue.trim().is_empty() {
        String::new()
    } else {
        format!("Task issue: {}\n", node.github_issue.trim())
    };
    let resolved_profile = if config.selected_profile.trim().is_empty() {
        "(default)".to_string()
    } else {
        config.selected_profile.clone()
    };
    format!(
        "# Child Task: {node_id}\n\nRepo: {repo_root}\nWorktree: {worktree}\nBase branch: {base_branch}\nPublish branch: {branch}\nResolved profile: {resolved_profile}\n{issue_line}## Scope\n{scope}\n\n## Allowed Files\n{allowed_files}\n\n## Tests\n{tests}\n\n## Acceptance Checks\n{acceptance_checks}\n\n## Instructions\n{instructions}\n\n## Runtime Contract\n- Work only inside the provided worktree.\n- If you need to publish, use `bun run pr:publish` and include a valid GitHub pull request URL in the status JSON.\n- Write status JSON to `{status_path}`.\n- Include `tests` and `changed_files` in the status JSON.\n- Preferred writing language: {writing_language}.\n",
        node_id = node.id,
        repo_root = repo_root.display(),
        worktree = worktree_path.display(),
        branch = node.branch,
        resolved_profile = resolved_profile,
        issue_line = issue_line,
        scope = if node.scope.trim().is_empty() {
            "(not provided)"
        } else {
            node.scope.trim()
        },
        allowed_files = allowed_files,
        tests = tests,
        acceptance_checks = acceptance_checks,
        instructions = if node.instructions.trim().is_empty() {
            "(none)"
        } else {
            node.instructions.trim()
        },
        status_path = worktree_status_path(worktree_path, &node.id).display(),
        writing_language = config.writing_language,
    )
}

fn write_task_prompt(
    state_dir: &Path,
    repo_root: &Path,
    worktree_path: &Path,
    node: &ExecutionPlanNode,
    base_branch: &str,
    config: &ResolvedRunConfig,
) -> Result<PathBuf, String> {
    let task_path = task_file_path(state_dir, &node.id);
    if let Some(parent) = task_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(
        &task_path,
        render_task_prompt(repo_root, worktree_path, node, base_branch, config),
    )
    .map_err(|error| format!("failed to write {}: {error}", task_path.display()))?;
    Ok(task_path)
}

fn prepare_worktree_env(
    repo_root: &Path,
    worktree_path: &Path,
    task_file: &Path,
    node: &ExecutionPlanNode,
    base_branch: &str,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut env_map = std::collections::BTreeMap::new();
    for (key, value) in env::vars() {
        env_map.insert(key, value);
    }
    env_map.insert(
        "ORCH_TASK_FILE".to_string(),
        task_file.display().to_string(),
    );
    env_map.insert(
        "ORCH_WORKTREE".to_string(),
        worktree_path.display().to_string(),
    );
    env_map.insert("ORCH_NODE_ID".to_string(), node.id.clone());
    env_map.insert("ORCH_BRANCH".to_string(), node.branch.clone());
    env_map.insert("ORCH_BASE_BRANCH".to_string(), base_branch.to_string());
    env_map.insert(
        "ORCH_REPO_ROOT".to_string(),
        repo_root.display().to_string(),
    );
    Ok(env_map)
}

fn spawn_command_process(
    command_template: &str,
    repo_root: &Path,
    worktree_path: &Path,
    task_file: &Path,
    node: &ExecutionPlanNode,
    base_branch: &str,
    env_map: &std::collections::BTreeMap<String, String>,
) -> Result<Child, String> {
    let command = command_template
        .replace("{task_file}", &task_file.display().to_string())
        .replace("{worktree}", &worktree_path.display().to_string())
        .replace("{node_id}", &node.id)
        .replace("{branch}", &node.branch)
        .replace("{base_branch}", base_branch)
        .replace("{repo_root}", &repo_root.display().to_string());
    Command::new("sh")
        .args(["-lc", &command])
        .current_dir(worktree_path)
        .envs(env_map)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to spawn command child executor: {error}"))
}

fn child_executor_kind(base_cmd: &str) -> String {
    let executable = Path::new(base_cmd)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(base_cmd)
        .to_lowercase();
    if executable.starts_with("codex") {
        "codex".to_string()
    } else {
        "claude".to_string()
    }
}

fn spawn_child_exec_process(
    config: &ResolvedRunConfig,
    state_dir: &Path,
    worktree_path: &Path,
    task_file: &Path,
    node: &ExecutionPlanNode,
    base_branch: &str,
    env_map: &std::collections::BTreeMap<String, String>,
) -> Result<(Child, PathBuf, PathBuf), String> {
    let base_cmd = if config.child_exec_cmd.trim().is_empty() {
        "claude".to_string()
    } else {
        config.child_exec_cmd.trim().to_string()
    };
    let kind = child_executor_kind(&base_cmd);
    let child_root = state_dir.join("child-exec").join(&kind);
    let prompt_path = child_root.join("prompts").join(format!("{}.txt", node.id));
    let json_path = child_root.join("json").join(format!("{}.jsonl", node.id));
    let stderr_path = child_root.join("stderr").join(format!("{}.log", node.id));
    let last_path = child_root.join("last").join(format!("{}.txt", node.id));
    let meta_path = child_root.join("meta").join(format!("{}.json", node.id));
    for path in [
        &prompt_path,
        &json_path,
        &stderr_path,
        &last_path,
        &meta_path,
    ] {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
    }
    let prompt_text = render_task_prompt(worktree_path, worktree_path, node, base_branch, config);
    fs::write(&prompt_path, &prompt_text)
        .map_err(|error| format!("failed to write {}: {error}", prompt_path.display()))?;

    let mut args = shell_words(&config.child_exec_args);
    let mut command_args = Vec::<String>::new();
    if kind == "codex" {
        if args.is_empty() {
            args = vec![
                "exec".to_string(),
                "--json".to_string(),
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
                "-o".to_string(),
                last_path.display().to_string(),
            ];
        } else if args.first().map(String::as_str) != Some("exec") {
            args.insert(0, "exec".to_string());
        }
        if !args.iter().any(|entry| entry == "--json") {
            args.push("--json".to_string());
        }
        if !args
            .iter()
            .any(|entry| entry == "--dangerously-bypass-approvals-and-sandbox")
        {
            args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
        }
        if !args
            .iter()
            .any(|entry| entry == "-o" || entry == "--output-last-message")
        {
            args.push("-o".to_string());
            args.push(last_path.display().to_string());
        }
        command_args.extend(args);
        command_args.push(prompt_text);
    } else {
        if !args.iter().any(|entry| entry == "--output-format") {
            args.push("--output-format".to_string());
            args.push("json".to_string());
        }
        if !args
            .iter()
            .any(|entry| entry == "--dangerously-skip-permissions")
        {
            args.push("--dangerously-skip-permissions".to_string());
        }
        command_args.extend(args);
        command_args.push("-p".to_string());
        command_args.push(prompt_text);
    }

    write_json_value(
        &meta_path,
        &json!({
            "node_id": node.id,
            "child_executor": kind,
            "worktree": worktree_path.display().to_string(),
            "task_file": task_file.display().to_string(),
            "json_output": json_path.display().to_string(),
            "stderr_log": stderr_path.display().to_string(),
            "last_message": last_path.display().to_string(),
            "started_at": now_iso_utc(),
        }),
    )?;

    let stdout_file = fs::File::create(&json_path)
        .map_err(|error| format!("failed to create {}: {error}", json_path.display()))?;
    let stderr_file = fs::File::create(&stderr_path)
        .map_err(|error| format!("failed to create {}: {error}", stderr_path.display()))?;
    let child = Command::new(&base_cmd)
        .args(&command_args)
        .current_dir(worktree_path)
        .envs(env_map)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|error| format!("failed to spawn child-exec process: {error}"))?;
    Ok((child, json_path, stderr_path))
}

fn file_mtime_iso(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    OffsetDateTime::from_unix_timestamp(duration.as_secs() as i64)
        .ok()
        .and_then(|timestamp| timestamp.format(&Rfc3339).ok())
}

fn read_status_value(
    state_dir: &Path,
    worktree_path: &Path,
    node_id: &str,
) -> Result<Option<Value>, String> {
    let canonical_path = canonical_status_path(state_dir, node_id);
    if canonical_path.is_file() {
        return Ok(Some(read_json_value(&canonical_path)?));
    }
    let worktree_path = worktree_status_path(worktree_path, node_id);
    if !worktree_path.is_file() {
        return Ok(None);
    }
    let payload = read_json_value(&worktree_path)?;
    write_json_value(&canonical_path, &payload)?;
    Ok(Some(payload))
}

fn status_text(status: &Value) -> String {
    status
        .as_object()
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

fn validate_status_tests_payload(status: &Value) -> Result<(), String> {
    let tests = status
        .as_object()
        .and_then(|value| value.get("tests"))
        .and_then(Value::as_array)
        .ok_or_else(|| "status.tests is required".to_string())?;
    if tests.is_empty() {
        return Err("status.tests must not be empty".to_string());
    }
    for entry in tests {
        let result = entry
            .as_object()
            .and_then(|value| value.get("result"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if result != "pass" && result != "passed" && result != "ok" && result != "success" {
            let command = entry
                .as_object()
                .and_then(|value| value.get("cmd"))
                .and_then(Value::as_str)
                .unwrap_or("tests[]");
            return Err(format!("{command}: {result}"));
        }
    }
    Ok(())
}

fn path_matches_allowed_file(changed_path: &str, allowed_pattern: &str) -> bool {
    let changed = changed_path.trim();
    let pattern = allowed_pattern.trim();
    if changed.is_empty() || pattern.is_empty() {
        return false;
    }
    if let Some(prefix) = pattern.strip_suffix("/**") {
        return changed == prefix || changed.starts_with(&format!("{prefix}/"));
    }
    changed == pattern
}

fn validate_allowed_files(node: &ExecutionPlanNode, status: &Value) -> Result<(), String> {
    if node.allowed_files.is_empty() {
        return Ok(());
    }
    let changed_files = status
        .as_object()
        .and_then(|value| value.get("changed_files"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "status.changed_files is required when allowed_files is configured".to_string()
        })?;
    for entry in changed_files {
        let changed = entry.as_str().unwrap_or("").trim();
        if changed.is_empty() {
            continue;
        }
        if node
            .allowed_files
            .iter()
            .any(|pattern| path_matches_allowed_file(changed, pattern))
        {
            continue;
        }
        return Err(format!(
            "allowed_files gate failed: {changed} is out of scope"
        ));
    }
    Ok(())
}

fn validate_remote_pr_url(repository: &str, status: &Value) -> Result<(), String> {
    let pr_url = status
        .as_object()
        .and_then(|value| value.get("pr_url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if pr_url.is_empty() {
        return Err("status.pr_url is required for remote-pr mode".to_string());
    }
    let expected_prefix = format!("https://github.com/{repository}/pull/");
    if !pr_url.starts_with(&expected_prefix) {
        return Err(format!("invalid PR URL: {pr_url}"));
    }
    Ok(())
}

fn run_shell_check(cwd: &Path, command: &str) -> Result<(bool, Value), String> {
    let result = Command::new("sh")
        .args(["-lc", command])
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("failed to run gate command '{command}': {error}"))?;
    let stdout = String::from_utf8_lossy(&result.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
    let notes = if stderr.trim().is_empty() {
        stdout.trim().chars().take(2000).collect::<String>()
    } else {
        stderr.trim().chars().take(2000).collect::<String>()
    };
    Ok((
        result.status.success(),
        json!({
            "name": command,
            "cmd": command,
            "result": if result.status.success() { "pass" } else { "fail" },
            "exit_code": result.status.code(),
            "notes": notes,
        }),
    ))
}

fn append_status_tests(status_path: &Path, additional: &[Value]) -> Result<Value, String> {
    let mut payload = read_json_value(status_path)?;
    let object = ensure_object_mut(&mut payload, "status")?;
    let tests = object
        .entry("tests".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let tests_array = tests
        .as_array_mut()
        .ok_or_else(|| format!("status.tests must be an array: {}", status_path.display()))?;
    tests_array.extend(additional.iter().cloned());
    write_json_value(status_path, &payload)?;
    Ok(payload)
}

fn resolve_worktree_gate_commands(
    config: &ResolvedRunConfig,
    node: &ExecutionPlanNode,
) -> Result<Vec<String>, String> {
    if !config.worktree_gate_enabled {
        return Ok(Vec::new());
    }
    if config.worktree_gate_mode == "node-scope" {
        let scope_gate_keys = node
            .task_scope
            .as_ref()
            .map(|value| value.scope_gate_keys.clone())
            .unwrap_or_default();
        let mut commands = Vec::new();
        for key in scope_gate_keys {
            if let Some(command) = config.worktree_scope_gate_cmds.get(&key) {
                if !command.trim().is_empty() && !commands.iter().any(|entry| entry == command) {
                    commands.push(command.trim().to_string());
                }
            } else if config.worktree_fail_on_unmapped_scope {
                return Err(format!("missing worktree gate command for scope '{key}'"));
            }
        }
        if commands.is_empty() && config.worktree_fail_on_unmapped_scope {
            return Err(format!(
                "node {} has no resolvable worktree gate command",
                node.id
            ));
        }
        return Ok(commands);
    }
    if !config.worktree_gate_cmd.trim().is_empty() {
        return Ok(vec![config.worktree_gate_cmd.clone()]);
    }
    Ok(Vec::new())
}

fn wait_for_review_decision(
    options: &RunOptions,
    config: &ResolvedRunConfig,
    node_id: &str,
) -> Result<String, String> {
    loop {
        if !config.auto_approve && !canonical_review_path(&options.state_dir, node_id).is_file() {
            thread::sleep(Duration::from_secs(1));
            continue;
        }
        let mut args = vec![
            "review-decision".to_string(),
            "--state-dir".to_string(),
            options.state_dir.display().to_string(),
            "--node-id".to_string(),
            node_id.to_string(),
        ];
        if config.auto_approve {
            args.push("--auto-approve".to_string());
        }
        let code = run_review_decision(&args)?;
        if code != 0 {
            return Err("review-decision helper failed".to_string());
        }
        let review_path = canonical_review_path(&options.state_dir, node_id);
        if config.auto_approve || review_path.is_file() {
            let payload = read_json_value(&review_path)?;
            let decision = payload
                .as_object()
                .and_then(|value| value.get("decision"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !decision.is_empty() {
                return Ok(decision);
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn schedule_retry_and_reload(
    options: &RunOptions,
    node_id: &str,
    summary: &str,
    failure_reason: &str,
    now_iso: &str,
    extra: Option<Value>,
) -> Result<Value, String> {
    let mut args = vec![
        "schedule-retry".to_string(),
        "--state-dir".to_string(),
        options.state_dir.display().to_string(),
        "--node-id".to_string(),
        node_id.to_string(),
        "--summary".to_string(),
        summary.to_string(),
        "--failure-reason".to_string(),
        failure_reason.to_string(),
        "--now-iso".to_string(),
        now_iso.to_string(),
        "--max-retries".to_string(),
        "3".to_string(),
        "--backoff-base".to_string(),
        "10".to_string(),
        "--backoff-factor".to_string(),
        "2".to_string(),
        "--backoff-max".to_string(),
        "300".to_string(),
    ];
    if let Some(extra_value) = extra {
        args.push("--extra-json".to_string());
        args.push(
            serde_json::to_string(&extra_value)
                .map_err(|error| format!("failed to serialize retry payload: {error}"))?,
        );
    }
    run_schedule_retry(&args)?;
    read_json_value(&options.state_dir.join("state.json"))
}

fn mark_terminal_from_status(
    state: &mut Value,
    node_id: &str,
    status: &Value,
) -> Result<(), String> {
    let status_text = status_text(status);
    let status_obj = status.as_object().cloned().unwrap_or_default();
    let node = node_object_mut(state, node_id)?;
    node.insert("status".to_string(), Value::String(status_text.clone()));
    node.insert(
        "last_failure_reason".to_string(),
        Value::String(
            status_obj
                .get("failure_reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
        ),
    );
    node.insert(
        "last_failure_summary".to_string(),
        Value::String(
            status_obj
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
        ),
    );
    node.insert(
        "blocked_reason".to_string(),
        Value::String(
            status_obj
                .get("failure_reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
        ),
    );
    node.insert("retry_ready_at".to_string(), Value::String(String::new()));
    node.insert(
        "retry_exhausted_at".to_string(),
        Value::String(String::new()),
    );
    node.insert(
        "escalation_level".to_string(),
        Value::String(if status_text == "done" {
            "none".to_string()
        } else {
            "manual".to_string()
        }),
    );
    node.insert(
        "escalation_reason".to_string(),
        Value::String(
            status_obj
                .get("failure_reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
        ),
    );
    node.insert("last_update".to_string(), Value::String(now_iso_utc()));
    Ok(())
}

fn remove_worktree(repo_root: &Path, worktree_path: &Path) {
    let _ = run_command(
        repo_root,
        "git",
        [
            "worktree",
            "remove",
            "--force",
            &worktree_path.display().to_string(),
        ],
    );
    let _ = run_command(repo_root, "git", ["worktree", "prune"]);
}

fn run_run(args: &[String]) -> Result<i32, String> {
    let options = parse_run_options(args)?;
    let config = load_resolved_run_config(&options)?;
    let state_dir = canonical_or_existing_path(&options.state_dir)?;
    let state_path = state_dir.join("state.json");
    let execution_plan =
        read_execution_plan(&state_dir.join("inputs").join("execution-plan.json"))?;
    if execution_plan.nodes.len() != 1 {
        return Err(format!(
            "run supports exactly one execution-plan node; got {}",
            execution_plan.nodes.len()
        ));
    }
    if execution_plan.merge_mode.trim() != "remote-pr" {
        return Err("run supports merge_mode=remote-pr only".to_string());
    }
    let node = execution_plan.nodes[0].clone();
    let repository = execution_plan.issue_tracking.repository.clone();
    let worktree_root = {
        let state_payload = read_state_payload(&state_path)?;
        let configured_state_backend = state_payload.github_state.state_backend.trim();
        if !configured_state_backend.is_empty() && configured_state_backend != options.state_backend
        {
            return Err(format!(
                "state backend mismatch: run requested '{}' but state.json is configured for '{}'",
                options.state_backend, configured_state_backend
            ));
        }
        if !state_payload.runtime.worktree_root.trim().is_empty() {
            PathBuf::from(state_payload.runtime.worktree_root)
        } else {
            resolve_session_worktree_root(&options.repo_root, &options.session_id)?
        }
    };
    let mut state = read_json_value(&state_path)?;
    persist_runtime_artifacts(
        &state_path,
        &mut state,
        &state_dir,
        &node,
        config.auto_approve,
    )?;

    loop {
        let current_status = node_status(&state, &node.id)?;
        if current_status == "done" || current_status == "failed" || current_status == "blocked" {
            break;
        }
        if current_status != "pending" {
            return Err(format!(
                "unsupported non-terminal state for single-node runtime: {}",
                current_status
            ));
        }

        let worktree_path = ensure_managed_worktree(
            &options.repo_root,
            &worktree_root,
            &node,
            &execution_plan.base_branch,
            &options.session_id,
        )?;
        let task_file = write_task_prompt(
            &state_dir,
            &options.repo_root,
            &worktree_path,
            &node,
            &execution_plan.base_branch,
            &config,
        )?;
        let env_map = prepare_worktree_env(
            &options.repo_root,
            &worktree_path,
            &task_file,
            &node,
            &execution_plan.base_branch,
        )?;
        if config.require_worktree_setup && !config.setup_worktree_cmd.trim().is_empty() {
            let (ok, result) = run_shell_check(&worktree_path, &config.setup_worktree_cmd)?;
            if !ok {
                write_failed_status_value(
                    &state_dir,
                    &node.id,
                    &format!(
                        "worktree setup failed: {}",
                        result
                            .as_object()
                            .and_then(|value| value.get("notes"))
                            .and_then(Value::as_str)
                            .unwrap_or("command failed")
                    ),
                    "worktree_setup_failed",
                )?;
                mark_terminal_from_status(
                    &mut state,
                    &node.id,
                    &read_json_value(&canonical_status_path(&state_dir, &node.id))?,
                )?;
                persist_runtime_artifacts(
                    &state_path,
                    &mut state,
                    &state_dir,
                    &node,
                    config.auto_approve,
                )?;
                break;
            }
        }
        {
            let node_state = node_object_mut(&mut state, &node.id)?;
            node_state.insert("status".to_string(), Value::String("running".to_string()));
            node_state.insert(
                "worktree".to_string(),
                Value::String(worktree_path.display().to_string()),
            );
            node_state.insert("started_at".to_string(), Value::String(now_iso_utc()));
            node_state.insert("last_activity_at".to_string(), Value::String(now_iso_utc()));
            node_state.insert("last_update".to_string(), Value::String(now_iso_utc()));
        }
        clear_review_iteration_artifacts(&state_dir, &node.id)?;
        persist_runtime_artifacts(
            &state_path,
            &mut state,
            &state_dir,
            &node,
            config.auto_approve,
        )?;

        let child_start = OffsetDateTime::now_utc();
        let (mut child, json_log_path, _stderr_path) = if config.spawn_mode == "command" {
            let child = spawn_command_process(
                &config.command_exec_agent_cmd,
                &options.repo_root,
                &worktree_path,
                &task_file,
                &node,
                &execution_plan.base_branch,
                &env_map,
            )?;
            (child, PathBuf::new(), PathBuf::new())
        } else {
            spawn_child_exec_process(
                &config,
                &state_dir,
                &worktree_path,
                &task_file,
                &node,
                &execution_plan.base_branch,
                &env_map,
            )?
        };

        let mut latest_activity = OffsetDateTime::now_utc();
        loop {
            if let Some(status) = read_status_value(&state_dir, &worktree_path, &node.id)? {
                let status_kind = status_text(&status);
                if !status_kind.is_empty() {
                    latest_activity = OffsetDateTime::now_utc();
                }
            }
            if let Some(mtime) = file_mtime_iso(&canonical_status_path(&state_dir, &node.id)) {
                latest_activity = parse_utc_timestamp(&mtime)?;
            } else if json_log_path.is_file() {
                if let Some(mtime) = file_mtime_iso(&json_log_path) {
                    latest_activity = parse_utc_timestamp(&mtime)?;
                }
            }
            if config.max_runtime_seconds > 0
                && (OffsetDateTime::now_utc() - child_start).whole_seconds()
                    > config.max_runtime_seconds as i64
            {
                let _ = child.kill();
                let _ = child.wait();
                schedule_retry_and_reload(
                    &options,
                    &node.id,
                    &format!(
                        "node exceeded max runtime ({}s)",
                        config.max_runtime_seconds
                    ),
                    "node_max_runtime_exceeded",
                    &now_iso_utc(),
                    None,
                )?;
                break;
            }
            if config.stuck_timeout_seconds > 0
                && (OffsetDateTime::now_utc() - latest_activity).whole_seconds()
                    > config.stuck_timeout_seconds as i64
            {
                let _ = child.kill();
                let _ = child.wait();
                schedule_retry_and_reload(
                    &options,
                    &node.id,
                    &format!(
                        "node became stuck ({}s inactivity)",
                        config.stuck_timeout_seconds
                    ),
                    "node_stuck_timeout",
                    &now_iso_utc(),
                    None,
                )?;
                break;
            }
            if let Some(exit_status) = child
                .try_wait()
                .map_err(|error| format!("failed to poll child executor: {error}"))?
            {
                let status_value = read_status_value(&state_dir, &worktree_path, &node.id)?;
                if let Some(status) = status_value {
                    let status_kind = status_text(&status);
                    if status_kind == "ready_for_review" {
                        {
                            let node_state = node_object_mut(&mut state, &node.id)?;
                            node_state.insert(
                                "status".to_string(),
                                Value::String("ready_for_review".to_string()),
                            );
                            node_state
                                .insert("last_update".to_string(), Value::String(now_iso_utc()));
                        }
                        persist_runtime_artifacts(
                            &state_path,
                            &mut state,
                            &state_dir,
                            &node,
                            config.auto_approve,
                        )?;
                        let decision = wait_for_review_decision(&options, &config, &node.id)?;
                        state = read_json_value(&state_path)?;
                        if decision == "approve" {
                            let status_path = canonical_status_path(&state_dir, &node.id);
                            let status_payload = read_json_value(&status_path)?;
                            validate_allowed_files(&node, &status_payload)
                                .map_err(|detail| format!("review gate failed: {detail}"))?;
                            if config.require_passing_tests {
                                validate_status_tests_payload(&status_payload)
                                    .map_err(|detail| format!("tests gate failed: {detail}"))?;
                            }
                            let mut gate_results = Vec::<Value>::new();
                            if config.require_acceptance_checks {
                                for command in &node.acceptance_checks {
                                    let (ok, payload) = run_shell_check(&worktree_path, command)?;
                                    gate_results.push(payload);
                                    if !ok {
                                        write_failed_status_value(
                                            &state_dir,
                                            &node.id,
                                            &format!("acceptance gate failed: {command}"),
                                            "acceptance_gate_failed",
                                        )?;
                                        break;
                                    }
                                }
                            }
                            for command in resolve_worktree_gate_commands(&config, &node)? {
                                let (ok, payload) = run_shell_check(&worktree_path, &command)?;
                                gate_results.push(payload);
                                if !ok {
                                    write_failed_status_value(
                                        &state_dir,
                                        &node.id,
                                        &format!("worktree gate failed: {command}"),
                                        "worktree_gate_failed",
                                    )?;
                                    break;
                                }
                            }
                            if !gate_results.is_empty() && status_path.is_file() {
                                let updated_status =
                                    append_status_tests(&status_path, &gate_results)?;
                                if status_text(&updated_status) == "failed" {
                                    mark_terminal_from_status(
                                        &mut state,
                                        &node.id,
                                        &updated_status,
                                    )?;
                                    persist_runtime_artifacts(
                                        &state_path,
                                        &mut state,
                                        &state_dir,
                                        &node,
                                        config.auto_approve,
                                    )?;
                                    break;
                                }
                            }
                            validate_remote_pr_url(&repository, &read_json_value(&status_path)?)
                                .map_err(|detail| format!("remote-pr gate failed: {detail}"))?;
                            {
                                let node_state = node_object_mut(&mut state, &node.id)?;
                                node_state.insert(
                                    "status".to_string(),
                                    Value::String("done".to_string()),
                                );
                                node_state.insert(
                                    "last_update".to_string(),
                                    Value::String(now_iso_utc()),
                                );
                                node_state.insert(
                                    "escalation_level".to_string(),
                                    Value::String("none".to_string()),
                                );
                                node_state.insert(
                                    "escalation_reason".to_string(),
                                    Value::String(String::new()),
                                );
                            }
                            persist_runtime_artifacts(
                                &state_path,
                                &mut state,
                                &state_dir,
                                &node,
                                config.auto_approve,
                            )?;
                            if config.cleanup {
                                remove_worktree(&options.repo_root, &worktree_path);
                            }
                            break;
                        }
                        let node_state = node_status(&state, &node.id)?;
                        if node_state == "pending" {
                            break;
                        }
                        if node_state == "blocked" || node_state == "failed" {
                            persist_runtime_artifacts(
                                &state_path,
                                &mut state,
                                &state_dir,
                                &node,
                                config.auto_approve,
                            )?;
                            break;
                        }
                    } else if status_kind == "failed"
                        || status_kind == "blocked"
                        || status_kind == "done"
                    {
                        mark_terminal_from_status(&mut state, &node.id, &status)?;
                        persist_runtime_artifacts(
                            &state_path,
                            &mut state,
                            &state_dir,
                            &node,
                            config.auto_approve,
                        )?;
                        if status_kind == "done" && config.cleanup {
                            remove_worktree(&options.repo_root, &worktree_path);
                        }
                        break;
                    } else {
                        schedule_retry_and_reload(
                            &options,
                            &node.id,
                            &format!(
                                "child executor exited without terminal status (exit={})",
                                exit_status.code().unwrap_or(1)
                            ),
                            "child_executor_exited_without_status",
                            &now_iso_utc(),
                            None,
                        )?;
                        break;
                    }
                } else {
                    schedule_retry_and_reload(
                        &options,
                        &node.id,
                        &format!(
                            "child executor exited without status file (exit={})",
                            exit_status.code().unwrap_or(1)
                        ),
                        "child_executor_exited_without_status",
                        &now_iso_utc(),
                        None,
                    )?;
                    break;
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
        state = read_json_value(&state_path)?;
    }

    Ok(0)
}

fn canonical_or_existing_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        canonical_dir(path)
    } else if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(env::current_dir()
            .map_err(|error| format!("failed to resolve cwd: {error}"))?
            .join(path))
    }
}

fn read_json_value(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

fn write_json_value(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid JSON output path: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    fs::write(
        path,
        serde_json::to_string_pretty(value)
            .map_err(|error| format!("failed to serialize {}: {error}", path.display()))?
            + "\n",
    )
    .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

fn ensure_object_mut<'a>(
    value: &'a mut Value,
    label: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{label} must be a JSON object"))
}

fn canonical_status_path(state_dir: &Path, node_id: &str) -> PathBuf {
    state_dir.join("status").join(format!("{node_id}.json"))
}

fn canonical_review_path(state_dir: &Path, node_id: &str) -> PathBuf {
    state_dir.join("review").join(format!("{node_id}.json"))
}

fn clear_review_iteration_artifacts(state_dir: &Path, node_id: &str) -> Result<(), String> {
    for path in [
        canonical_status_path(state_dir, node_id),
        canonical_review_path(state_dir, node_id),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to remove {}: {error}", path.display())),
        }
    }
    Ok(())
}

fn write_failed_status_value(
    state_dir: &Path,
    node_id: &str,
    summary: &str,
    failure_reason: &str,
) -> Result<(), String> {
    write_json_value(
        &canonical_status_path(state_dir, node_id),
        &json!({
            "node_id": node_id,
            "status": "failed",
            "summary": summary,
            "failure_reason": failure_reason,
            "tests": [],
            "changed_files": [],
            "timestamp": now_iso_utc(),
        }),
    )
}

fn write_blocked_status_with_extra_value(
    state_dir: &Path,
    node_id: &str,
    summary: &str,
    failure_reason: &str,
    extra: &Value,
) -> Result<(), String> {
    let mut payload = serde_json::Map::from_iter([
        ("node_id".to_string(), Value::String(node_id.to_string())),
        ("status".to_string(), Value::String("blocked".to_string())),
        ("summary".to_string(), Value::String(summary.to_string())),
        (
            "failure_reason".to_string(),
            Value::String(failure_reason.to_string()),
        ),
        ("tests".to_string(), Value::Array(Vec::new())),
        ("changed_files".to_string(), Value::Array(Vec::new())),
        ("timestamp".to_string(), Value::String(now_iso_utc())),
    ]);
    if let Some(extra_object) = extra.as_object() {
        for (key, value) in extra_object {
            payload.insert(key.clone(), value.clone());
        }
    }
    write_json_value(
        &canonical_status_path(state_dir, node_id),
        &Value::Object(payload),
    )
}

fn write_blocked_status_value(
    state_dir: &Path,
    node_id: &str,
    summary: &str,
    failure_reason: &str,
    review: &Value,
) -> Result<(), String> {
    write_blocked_status_with_extra_value(
        state_dir,
        node_id,
        summary,
        failure_reason,
        &json!({ "review": review }),
    )
}

fn compute_backoff_seconds(attempts: u64, base_seconds: u64, factor: f64, max_seconds: u64) -> u64 {
    if attempts == 0 {
        return 0;
    }
    let delay = (base_seconds as f64) * factor.powf((attempts - 1) as f64);
    let bounded = delay.min(max_seconds as f64);
    if bounded.is_finite() && bounded > 0.0 {
        bounded.floor() as u64
    } else {
        0
    }
}

fn retry_ready_at(
    now_iso: &str,
    attempts: u64,
    base_seconds: u64,
    factor: f64,
    max_seconds: u64,
) -> Result<String, String> {
    let now_dt = parse_utc_timestamp(now_iso)?;
    let backoff = compute_backoff_seconds(attempts, base_seconds, factor, max_seconds);
    (now_dt + time::Duration::seconds(backoff as i64))
        .format(&Rfc3339)
        .map_err(|error| format!("failed to format retry_ready_at: {error}"))
}

fn parse_utc_timestamp(value: &str) -> Result<OffsetDateTime, String> {
    if value.len() != 20 || !value.ends_with('Z') {
        return Err(format!("invalid --now-iso timestamp: {value}"));
    }
    let year = value[0..4]
        .parse::<i32>()
        .map_err(|error| format!("invalid --now-iso timestamp year: {error}"))?;
    let month_number = value[5..7]
        .parse::<u8>()
        .map_err(|error| format!("invalid --now-iso timestamp month: {error}"))?;
    let day = value[8..10]
        .parse::<u8>()
        .map_err(|error| format!("invalid --now-iso timestamp day: {error}"))?;
    let hour = value[11..13]
        .parse::<u8>()
        .map_err(|error| format!("invalid --now-iso timestamp hour: {error}"))?;
    let minute = value[14..16]
        .parse::<u8>()
        .map_err(|error| format!("invalid --now-iso timestamp minute: {error}"))?;
    let second = value[17..19]
        .parse::<u8>()
        .map_err(|error| format!("invalid --now-iso timestamp second: {error}"))?;
    let month = Month::try_from(month_number)
        .map_err(|error| format!("invalid --now-iso timestamp month: {error}"))?;
    let date = Date::from_calendar_date(year, month, day)
        .map_err(|error| format!("invalid --now-iso timestamp date: {error}"))?;
    let time = Time::from_hms(hour, minute, second)
        .map_err(|error| format!("invalid --now-iso timestamp time: {error}"))?;
    Ok(PrimitiveDateTime::new(date, time).assume_offset(UtcOffset::UTC))
}

fn parse_review_artifact_value(review: &Value, node_id: &str) -> Result<Value, String> {
    let object = review
        .as_object()
        .ok_or_else(|| format!("review artifact for {node_id} must be a JSON object"))?;
    let decision = object
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if decision != "approve" && decision != "rework" && decision != "reject" {
        return Err(format!(
            "review artifact for {node_id} must include decision=['approve', 'reject', 'rework']"
        ));
    }
    let summary = object
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let reviewer_lane = object
        .get("reviewer_lane")
        .and_then(Value::as_str)
        .unwrap_or("manual")
        .trim()
        .to_string();
    let reviewed_at = object
        .get("reviewed_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let findings = object
        .get("findings")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    if !findings.is_array() {
        return Err(format!(
            "review artifact for {node_id} must include findings[]"
        ));
    }
    let escalation = object
        .get("escalation")
        .cloned()
        .unwrap_or_else(|| json!({"level": "none", "reason": ""}));
    let escalation_obj = escalation
        .as_object()
        .ok_or_else(|| format!("review artifact for {node_id} escalation must be an object"))?;
    let escalation_level = escalation_obj
        .get("level")
        .and_then(Value::as_str)
        .unwrap_or("none")
        .trim()
        .to_lowercase();
    if escalation_level != "none" && escalation_level != "manual" {
        return Err(format!(
            "review artifact for {node_id} escalation.level must be one of ['manual', 'none']"
        ));
    }
    let escalation_reason = escalation_obj
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if escalation_level == "manual" && escalation_reason.is_empty() {
        return Err(format!(
            "review artifact for {node_id} escalation.reason is required"
        ));
    }
    Ok(json!({
        "node_id": node_id,
        "decision": decision,
        "summary": summary,
        "reviewer_lane": if reviewer_lane.is_empty() { "manual" } else { reviewer_lane.as_str() },
        "reviewed_at": if reviewed_at.is_empty() { now_iso_utc() } else { reviewed_at },
        "findings": findings,
        "escalation": {
            "level": escalation_level,
            "reason": escalation_reason,
        },
    }))
}

fn build_auto_approve_review_value(node_id: &str) -> Value {
    json!({
        "node_id": node_id,
        "decision": "approve",
        "summary": "auto-approved by orchestrator reviewer lane",
        "reviewer_lane": "auto",
        "reviewed_at": now_iso_utc(),
        "findings": [],
        "escalation": {
            "level": "none",
            "reason": "",
        },
    })
}

fn format_repo_safety_detail_from_summary(summary: &RepoSafetySummary) -> String {
    if summary.blocking_reasons.is_empty() {
        return "recommended_phase=execute".to_string();
    }
    summary
        .blocking_reasons
        .iter()
        .map(|entry| {
            if entry.detail.trim().is_empty() {
                entry.code.clone()
            } else {
                format!("{}: {}", entry.code, entry.detail)
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn evaluate_template_sot_files(repo_root: &Path) -> (bool, String) {
    let pr_template = repo_root.join(".github").join("PULL_REQUEST_TEMPLATE.md");
    let issue_template = repo_root
        .join(".github")
        .join("ISSUE_TEMPLATE")
        .join("task.yml");
    let mut missing = Vec::new();
    if !pr_template.is_file() {
        missing.push(".github/PULL_REQUEST_TEMPLATE.md".to_string());
    }
    if !issue_template.is_file() {
        missing.push(".github/ISSUE_TEMPLATE/task.yml".to_string());
    }
    if missing.is_empty() {
        (true, "required template SoT files are present".to_string())
    } else {
        (
            false,
            format!(
                "missing required template SoT files: {}",
                missing.join(", ")
            ),
        )
    }
}

fn parse_github_repo_from_origin_url(origin_url: &str) -> String {
    let text = origin_url.trim();
    if text.is_empty() {
        return String::new();
    }
    if let Some(captures) = Regex::new(r"^git@github\.com:([^/]+/[^/]+?)(?:\.git)?$")
        .expect("valid github ssh regex")
        .captures(text)
    {
        return captures
            .get(1)
            .map(|capture| capture.as_str().to_string())
            .unwrap_or_default();
    }
    if let Some(captures) = Regex::new(r"^https?://github\.com/([^/]+/[^/]+?)(?:\.git)?$")
        .expect("valid github https regex")
        .captures(text)
    {
        return captures
            .get(1)
            .map(|capture| capture.as_str().to_string())
            .unwrap_or_default();
    }
    String::new()
}

fn resolve_github_repo_slug(repo_root: &Path) -> Result<String, String> {
    let remote = run_command(repo_root, "git", ["remote", "get-url", "origin"])?;
    if remote.status != 0 {
        return Ok(String::new());
    }
    Ok(parse_github_repo_from_origin_url(remote.stdout.trim()))
}

fn run_remote_pr_preflight(repo_root: &Path) -> Result<(bool, String), String> {
    let repo_slug = resolve_github_repo_slug(repo_root)?;
    if repo_slug.trim().is_empty() {
        return Ok((
            false,
            "failed to resolve owner/repo from git remote origin".to_string(),
        ));
    }
    let gh_token = env::var("GH_TOKEN").unwrap_or_default();
    if gh_token.trim().is_empty() {
        return Ok((false, "missing GH_TOKEN for remote-pr mode".to_string()));
    }
    Ok((true, format!("repo={repo_slug}")))
}

fn resolve_merge_head_clean(repo_root: &Path) -> Result<(bool, String), String> {
    let merge_head = run_command(repo_root, "git", ["rev-parse", "--git-path", "MERGE_HEAD"])?;
    if merge_head.status != 0 {
        return Err(format!(
            "failed to resolve MERGE_HEAD path: {}",
            command_detail(&merge_head)
        ));
    }
    let raw = merge_head.stdout.trim();
    if raw.is_empty() {
        return Err("failed to resolve MERGE_HEAD path".to_string());
    }
    let merge_head_path = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        repo_root.join(raw)
    };
    Ok((
        !merge_head_path.exists(),
        merge_head_path.display().to_string(),
    ))
}

fn branches_are_unique(nodes: &[(String, String)]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    for (_, branch) in nodes {
        if !seen.insert(branch.clone()) {
            return false;
        }
    }
    true
}

fn resolve_session_worktree_root(repo_root: &Path, session_id: &str) -> Result<PathBuf, String> {
    Ok(resolve_managed_worktree_root(repo_root)?
        .join("sessions")
        .join(session_id))
}

fn node_worktree_paths_are_unique(worktree_root: &Path, nodes: &[(String, String)]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    for (node_id, _) in nodes {
        let candidate = worktree_root.join(node_id);
        if !seen.insert(candidate) {
            return false;
        }
    }
    true
}

fn attached_executor_worktrees(
    repo_root: &Path,
    worktree_root: &Path,
    nodes: &[(String, String)],
) -> Result<Vec<String>, String> {
    let entries = parse_worktree_entries(repo_root)?;
    let mut attached = Vec::new();
    for (node_id, _) in nodes {
        let expected = worktree_root.join(node_id);
        for entry in &entries {
            let resolved = canonical_dir(Path::new(&entry.path))
                .unwrap_or_else(|_| PathBuf::from(&entry.path));
            if resolved != expected {
                continue;
            }
            if !entry.branch.trim().is_empty() {
                attached.push(format!("{node_id}:refs/heads/{}", entry.branch.trim()));
            }
        }
    }
    Ok(attached)
}

fn command_exists(program: &str) -> bool {
    which_like(program).is_some()
}

fn which_like(program: &str) -> Option<String> {
    let path_value = env::var("PATH").ok()?;
    for dir in env::split_paths(&path_value) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate.display().to_string());
        }
        #[cfg(windows)]
        {
            let exe_candidate = dir.join(format!("{program}.exe"));
            if exe_candidate.is_file() {
                return Some(exe_candidate.display().to_string());
            }
        }
    }
    None
}

fn managed_worktree_dir_pattern() -> &'static Regex {
    static CACHE: OnceLock<Regex> = OnceLock::new();
    CACHE.get_or_init(|| {
        Regex::new(
            r"^(MAIN-[A-Z0-9._-]+|[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[A-Za-z0-9._-]*)$",
        )
        .expect("invalid managed worktree pattern")
    })
}

fn is_managed_worktree_dir_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('.') || name.starts_with('_') {
        return false;
    }
    managed_worktree_dir_pattern().is_match(name)
}

fn ephemeral_unregistered_top_level_names() -> &'static [&'static str] {
    &[".DS_Store", ".env", ".env.local", ".env.tools", ".tmp"]
}

fn git_success(repo_root: &Path, args: &[&str]) -> Result<bool, String> {
    let result = run_command(repo_root, "git", args)?;
    Ok(result.status == 0)
}

fn git_stdout(repo_root: &Path, args: &[&str]) -> Result<String, String> {
    let result = run_command(repo_root, "git", args)?;
    if result.status != 0 {
        return Err(command_detail(&result));
    }
    Ok(result.stdout)
}

fn git_optional_stdout(repo_root: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let result = run_command(repo_root, "git", args)?;
    if result.status == 0 {
        return Ok(Some(result.stdout));
    }
    Ok(None)
}

fn run_worktree_classify(args: &[String]) -> Result<i32, String> {
    let mut base_ref = "main".to_string();
    let mut include_base = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--base" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--base requires a branch name".to_string());
                };
                base_ref = value.clone();
                index += 2;
            }
            "--include-base" => {
                include_base = true;
                index += 1;
            }
            "-h" | "--help" => {
                println!(
                    "{}",
                    [
                        "Usage: omta-orchestrator worktree-classify [--base <branch>] [--include-base]",
                        "",
                        "Classify git worktrees into:",
                        "  1.main-unmerged-clean",
                        "  2.main-unmerged-dirty",
                        "  3.main-merged (ancestor or patch-equivalent)",
                        "  4.main-invalid (worktree metadata does not resolve to a valid commit)",
                        "",
                        "Output columns:",
                        "  <group>\\t<branch>\\tahead=<n>\\tbehind=<n>\\t<worktree-path>\\tmerge_reason=<ancestor|patch-equivalent|unmerged|invalid-ref|status-unavailable>",
                        "",
                        "Options:",
                        "  --base <branch>   Base branch to compare against (default: main)",
                        "  --include-base    Include the base branch worktree in output",
                        "  -h, --help        Show this help",
                    ]
                    .join("\n")
                );
                return Ok(0);
            }
            other => {
                return Err(format!(
                    "Unknown option: {other}\n{}",
                    [
                        "Usage: omta-orchestrator worktree-classify [--base <branch>] [--include-base]",
                        "  -h, --help        Show this help",
                    ]
                    .join("\n")
                ));
            }
        }
    }

    let repo_root = current_repo_root()?;
    if !git_success(&repo_root, &["rev-parse", "--is-inside-work-tree"])? {
        return Err("Not inside a git repository.".to_string());
    }

    let resolved_base_ref = resolve_base_ref(&repo_root, &base_ref)?
        .ok_or_else(|| format!("Base branch/ref not found: {base_ref}"))?;
    let base_branch_name = normalize_base_branch_name(&resolved_base_ref);
    let entries = parse_worktree_entries(&repo_root)?;

    let mut lines = Vec::new();
    for entry in entries {
        if let Some(line) = classify_worktree_entry(
            &repo_root,
            &resolved_base_ref,
            &base_branch_name,
            include_base,
            &entry,
        )? {
            lines.push(line);
        }
    }

    if lines.is_empty() {
        println!("No worktrees to classify.");
        return Ok(0);
    }

    lines.sort();
    for line in lines {
        println!("{line}");
    }
    Ok(0)
}

fn resolve_base_ref(repo_root: &Path, base_ref: &str) -> Result<Option<String>, String> {
    let commit_ref = format!("{base_ref}^{{commit}}");
    if git_success(repo_root, &["rev-parse", "--verify", "-q", &commit_ref])? {
        return Ok(Some(base_ref.to_string()));
    }

    if !base_ref.starts_with("refs/") {
        let local_ref = format!("refs/heads/{base_ref}");
        let local_commit = format!("{local_ref}^{{commit}}");
        if git_success(repo_root, &["rev-parse", "--verify", "-q", &local_commit])? {
            return Ok(Some(local_ref));
        }

        let origin_ref = format!("refs/remotes/origin/{base_ref}");
        let origin_commit = format!("{origin_ref}^{{commit}}");
        if git_success(repo_root, &["rev-parse", "--verify", "-q", &origin_commit])? {
            return Ok(Some(origin_ref));
        }

        let pattern = format!("refs/remotes/*/{base_ref}");
        let remote_list = git_stdout(
            repo_root,
            &["for-each-ref", "--format=%(refname)", &pattern],
        )?;
        if let Some(remote_ref) = remote_list.lines().find(|line| !line.trim().is_empty()) {
            let remote_commit = format!("{remote_ref}^{{commit}}");
            if git_success(repo_root, &["rev-parse", "--verify", "-q", &remote_commit])? {
                return Ok(Some(remote_ref.to_string()));
            }
        }
    }

    Ok(None)
}

fn normalize_base_branch_name(value: &str) -> String {
    if let Some(stripped) = value.strip_prefix("refs/heads/") {
        return stripped.to_string();
    }
    if let Some(stripped) = value.strip_prefix("refs/remotes/") {
        return stripped
            .split_once('/')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_else(|| stripped.to_string());
    }
    value.strip_prefix("origin/").unwrap_or(value).to_string()
}

#[derive(Debug, Clone)]
struct WorktreeEntry {
    path: String,
    head: String,
    branch: String,
    detached: bool,
    prunable: bool,
    prunable_detail: String,
}

fn parse_worktree_entries(repo_root: &Path) -> Result<Vec<WorktreeEntry>, String> {
    let output = git_stdout(repo_root, &["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for raw_line in output.lines() {
        let line = raw_line.trim_end();
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            current = Some(WorktreeEntry {
                path: path.to_string(),
                head: String::new(),
                branch: String::new(),
                detached: false,
                prunable: false,
                prunable_detail: String::new(),
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.head = head.to_string();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            entry.branch = branch.trim_start_matches("refs/heads/").to_string();
        } else if line == "detached" {
            entry.detached = true;
        } else if let Some(detail) = line.strip_prefix("prunable") {
            entry.prunable = true;
            entry.prunable_detail = detail.trim().to_string();
        }
    }
    if let Some(entry) = current.take() {
        entries.push(entry);
    }
    Ok(entries)
}

fn classify_worktree_entry(
    repo_root: &Path,
    resolved_base_ref: &str,
    base_branch_name: &str,
    include_base: bool,
    entry: &WorktreeEntry,
) -> Result<Option<String>, String> {
    let path = entry.path.trim();
    if path.is_empty() {
        return Ok(None);
    }

    let branch_display = if entry.branch.is_empty() {
        "(detached)".to_string()
    } else {
        entry.branch.clone()
    };

    let head_valid = is_valid_commit_ref(repo_root, &entry.head)?;
    let branch_ref = if entry.branch.is_empty() {
        String::new()
    } else {
        format!("refs/heads/{}", entry.branch)
    };
    let branch_valid = if branch_ref.is_empty() {
        false
    } else {
        is_valid_commit_ref(repo_root, &branch_ref)?
    };

    if entry.branch.is_empty() && !head_valid {
        return Ok(Some(format_invalid_line(
            path,
            &branch_display,
            "invalid-ref",
        )));
    }
    if !entry.branch.is_empty() && !branch_valid && !head_valid {
        return Ok(Some(format_invalid_line(
            path,
            &branch_display,
            "invalid-ref",
        )));
    }

    let status_result = run_command(repo_root, "git", ["-C", path, "status", "--porcelain"])?;
    if status_result.status != 0 {
        return Ok(Some(format_invalid_line(
            path,
            &branch_display,
            "status-unavailable",
        )));
    }
    let dirty = !status_result.stdout.trim().is_empty();

    if entry.branch == base_branch_name && !include_base {
        return Ok(None);
    }

    let target_ref = if entry.branch.is_empty() || !branch_valid {
        entry.head.as_str()
    } else {
        branch_ref.as_str()
    };

    let (group, merge_reason) = if is_ancestor(repo_root, target_ref, resolved_base_ref)? {
        ("3.main-merged", "ancestor")
    } else if is_patch_equivalent(repo_root, resolved_base_ref, target_ref)? {
        ("3.main-merged", "patch-equivalent")
    } else if !dirty {
        ("1.main-unmerged-clean", "unmerged")
    } else {
        ("2.main-unmerged-dirty", "unmerged")
    };

    let counts = git_stdout(
        repo_root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{resolved_base_ref}...{target_ref}"),
        ],
    )?;
    let mut parts = counts.split_whitespace();
    let behind = parts.next().unwrap_or("0");
    let ahead = parts.next().unwrap_or("0");

    Ok(Some(format!(
        "{group}\t{branch_display}\tahead={ahead}\tbehind={behind}\t{path}\tmerge_reason={merge_reason}"
    )))
}

fn format_invalid_line(path: &str, branch: &str, merge_reason: &str) -> String {
    format!("4.main-invalid\t{branch}\tahead=0\tbehind=0\t{path}\tmerge_reason={merge_reason}")
}

fn is_valid_commit_ref(repo_root: &Path, value: &str) -> Result<bool, String> {
    if value.is_empty() || value == "0000000000000000000000000000000000000000" {
        return Ok(false);
    }
    let commit_ref = format!("{value}^{{commit}}");
    git_success(repo_root, &["rev-parse", "--verify", "-q", &commit_ref])
}

fn is_ancestor(
    repo_root: &Path,
    target_ref: &str,
    resolved_base_ref: &str,
) -> Result<bool, String> {
    git_success(
        repo_root,
        &["merge-base", "--is-ancestor", target_ref, resolved_base_ref],
    )
}

fn is_patch_equivalent(
    repo_root: &Path,
    resolved_base_ref: &str,
    target_ref: &str,
) -> Result<bool, String> {
    let result = run_command(repo_root, "git", ["cherry", resolved_base_ref, target_ref])?;
    if result.status != 0 {
        return Ok(false);
    }
    Ok(!result.stdout.lines().any(|line| line.starts_with('+')))
}

fn run_preflight_repo_safety(args: &[String]) -> Result<i32, String> {
    let mut allow_dirty_base = false;
    for token in args {
        match token.as_str() {
            "--allow-dirty-base" => allow_dirty_base = true,
            other => return Err(format!("unknown option: {other}")),
        }
    }

    let repo_root = current_repo_root()?;
    if !git_success(&repo_root, &["rev-parse", "--is-inside-work-tree"])? {
        return Err("Not inside a git repository.".to_string());
    }

    let current_worktree = canonical_dir(&repo_root)?;
    let Some(base_worktree) = resolve_base_worktree(&repo_root)? else {
        eprintln!("[error] failed to resolve base worktree.");
        eprintln!("[hint] run: bun run wt:start -- --task-id <TASK_ID> --slug <short-title>");
        return Ok(1);
    };
    if !base_worktree.is_dir() {
        eprintln!("[error] failed to resolve base worktree.");
        eprintln!("[hint] run: bun run wt:start -- --task-id <TASK_ID> --slug <short-title>");
        return Ok(1);
    }

    let base_branch = git_optional_stdout(&base_worktree, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .unwrap_or_default()
        .trim()
        .to_string();
    if base_branch != "main" {
        eprintln!(
            "[error] base worktree drift detected: path={} branch={} expected=main",
            base_worktree.display(),
            if base_branch.is_empty() {
                "detached"
            } else {
                base_branch.as_str()
            }
        );
        eprintln!(
            "[hint] run: cd \"{}\" && git switch main",
            base_worktree.display()
        );
        return Ok(1);
    }

    if current_worktree != base_worktree {
        if env::var("ORCHESTRATE_ALLOW_NON_BASE_CWD").unwrap_or_default() == "1" {
            eprintln!(
                "[warn] non-base invocation bypassed by ORCHESTRATE_ALLOW_NON_BASE_CWD=1 (cwd={}, base={})",
                current_worktree.display(),
                base_worktree.display()
            );
        } else {
            eprintln!("[error] orchestrate must be started from base main worktree.");
            eprintln!("[error] current: {}", current_worktree.display());
            eprintln!("[error] base   : {}", base_worktree.display());
            eprintln!("[hint] run: cd \"{}\"", base_worktree.display());
            return Ok(1);
        }
    }

    let status_output = git_stdout(
        &base_worktree,
        &[
            "-C",
            &base_worktree.display().to_string(),
            "status",
            "--porcelain",
            "-uall",
        ],
    )?;
    let lines: Vec<&str> = status_output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return Ok(0);
    }

    let changed_count = lines.len();
    let preview = lines.iter().take(5).copied().collect::<Vec<_>>().join("; ");
    if allow_dirty_base {
        eprintln!(
            "[warn] base worktree is dirty but bypassed by --allow-dirty-base ({} path(s), base={}): {}",
            changed_count,
            base_worktree.display(),
            preview
        );
        return Ok(0);
    }

    eprintln!(
        "[error] base worktree is dirty ({} path(s), base={}): {}",
        changed_count,
        base_worktree.display(),
        preview
    );
    eprintln!(
        "[hint] stop and preserve changes first (e.g. git stash push -u -m 'rescue/<timestamp>')"
    );
    Ok(1)
}

fn evaluate_base_worktree_reservation(repo_root: &Path) -> Result<(bool, String), String> {
    let Some(base_worktree) = resolve_base_worktree(repo_root)? else {
        return Ok((false, "failed to resolve base worktree".to_string()));
    };
    let branch_result = run_command(
        repo_root,
        "git",
        [
            "-C",
            &base_worktree.display().to_string(),
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
        ],
    )?;
    if branch_result.status != 0 {
        return Ok((
            false,
            format!(
                "failed to resolve branch for base worktree {}: {}",
                base_worktree.display(),
                command_detail(&branch_result)
            ),
        ));
    }
    let branch = branch_result.stdout.trim().to_string();
    if branch != "main" {
        return Ok((
            false,
            format!(
                "base worktree drift detected: path={} branch={} expected=main",
                base_worktree.display(),
                if branch.is_empty() {
                    "(detached)"
                } else {
                    branch.as_str()
                }
            ),
        ));
    }
    Ok((
        true,
        format!("path={} branch=main", base_worktree.display()),
    ))
}

fn evaluate_orchestrator_invocation_worktree(repo_root: &Path) -> Result<(bool, String), String> {
    let current_worktree = canonical_dir(repo_root)?;
    let Some(base_worktree) = resolve_base_worktree(repo_root)? else {
        return Ok((
            false,
            "failed to resolve base worktree for invocation check".to_string(),
        ));
    };
    if current_worktree == base_worktree {
        return Ok((
            true,
            format!(
                "current={} base={}",
                current_worktree.display(),
                base_worktree.display()
            ),
        ));
    }
    if env::var("ORCHESTRATE_ALLOW_NON_BASE_CWD").unwrap_or_default() == "1" {
        return Ok((
            true,
            format!(
                "bypassed via ORCHESTRATE_ALLOW_NON_BASE_CWD=1 (current={} base={})",
                current_worktree.display(),
                base_worktree.display()
            ),
        ));
    }
    Ok((
        false,
        format!(
            "orchestrator must run from base main worktree (current={} base={})",
            current_worktree.display(),
            base_worktree.display()
        ),
    ))
}

fn resolve_base_worktree(repo_root: &Path) -> Result<Option<PathBuf>, String> {
    if let Some(marker) = read_base_worktree_marker(repo_root)? {
        if marker.is_dir() {
            return Ok(Some(marker));
        }
    }
    detect_main_worktree(repo_root)
}

fn resolve_git_common_dir(repo_root: &Path) -> Result<PathBuf, String> {
    let output = git_stdout(
        repo_root,
        &[
            "-C",
            &repo_root.display().to_string(),
            "rev-parse",
            "--git-common-dir",
        ],
    )?;
    let raw = output.trim();
    if raw.is_empty() {
        return Err("failed to resolve git common dir".to_string());
    }
    let path = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        repo_root.join(raw)
    };
    canonical_dir(&path)
}

fn read_base_worktree_marker(repo_root: &Path) -> Result<Option<PathBuf>, String> {
    let common_dir = resolve_git_common_dir(repo_root)?;
    let marker_path = common_dir.join("omta/base-worktree.path");
    if !marker_path.is_file() {
        return Ok(None);
    }
    let value = fs::read_to_string(&marker_path)
        .map_err(|error| format!("failed to read {}: {error}", marker_path.display()))?;
    let marker_value = value
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .trim_matches('\r')
        .trim();
    if marker_value.is_empty() {
        return Ok(None);
    }
    let path = if Path::new(marker_value).is_absolute() {
        PathBuf::from(marker_value)
    } else {
        repo_root.join(marker_value)
    };
    Ok(Some(canonical_dir(&path)?))
}

fn detect_main_worktree(repo_root: &Path) -> Result<Option<PathBuf>, String> {
    let output = git_stdout(
        repo_root,
        &[
            "-C",
            &repo_root.display().to_string(),
            "worktree",
            "list",
            "--porcelain",
        ],
    )?;
    let mut current_path = String::new();
    for raw_line in output.lines() {
        let line = raw_line.trim_end();
        if line.is_empty() {
            current_path.clear();
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = path.to_string();
            continue;
        }
        if line == "branch refs/heads/main" && !current_path.is_empty() {
            return Ok(Some(canonical_dir(Path::new(&current_path))?));
        }
    }
    Ok(None)
}

fn run_repo_safety(args: &[String]) -> Result<i32, String> {
    let mut repo_root = ".".to_string();
    let mut base_branch = "main".to_string();
    let mut allow_dirty_base = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--repo-root" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--repo-root requires a value".to_string());
                };
                repo_root = value.clone();
                index += 2;
            }
            "--base-branch" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--base-branch requires a value".to_string());
                };
                base_branch = value.clone();
                index += 2;
            }
            "--allow-dirty-base" => {
                allow_dirty_base = true;
                index += 1;
            }
            other => return Err(format!("unknown option: {other}")),
        }
    }

    let summary =
        inspect_repo_safety_summary(Path::new(&repo_root), &base_branch, allow_dirty_base)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&summary)
            .map_err(|error| format!("failed to serialize repo safety summary: {error}"))?
    );
    Ok(0)
}

fn inspect_repo_safety_summary(
    repo_root: &Path,
    base_branch: &str,
    allow_dirty_base: bool,
) -> Result<RepoSafetySummary, String> {
    let repo_root = canonical_dir(repo_root)?;
    let (base_worktree_clean, base_worktree_detail) = evaluate_base_worktree_clean(&repo_root)?;
    let worktree_entries = parse_worktree_entries(&repo_root)?;
    let registered_worktree_count = worktree_entries.len();
    let invalid_worktrees = collect_invalid_worktree_classifications(&repo_root, base_branch)?;
    let prunable_worktrees = worktree_entries
        .iter()
        .filter(|entry| entry.prunable)
        .map(|entry| PrunableWorktree {
            worktree: canonical_dir(Path::new(&entry.path))
                .unwrap_or_else(|_| PathBuf::from(&entry.path))
                .display()
                .to_string(),
            detail: if entry.prunable_detail.trim().is_empty() {
                "prunable".to_string()
            } else {
                entry.prunable_detail.clone()
            },
        })
        .collect::<Vec<_>>();
    let managed_worktree_root = resolve_managed_worktree_root(&repo_root)?;
    let unregistered_managed_dirs =
        collect_unregistered_managed_dirs(&managed_worktree_root, &worktree_entries)?;
    let unregistered_managed_dir_classifications = unregistered_managed_dirs
        .iter()
        .map(|path| classify_unregistered_managed_dir(path))
        .collect::<Result<Vec<_>, _>>()?;
    let unregistered_managed_dir_disposition_counts =
        summarize_disposition_counts(&unregistered_managed_dir_classifications);
    let missing_runtime_contract_worktrees = collect_missing_runtime_contract_worktrees(
        &managed_worktree_root,
        &worktree_entries,
        base_branch,
    )?;

    let mut blocking_reasons = Vec::new();
    if !base_worktree_clean && !allow_dirty_base {
        blocking_reasons.push(BlockingReason {
            code: "base_worktree_dirty".to_string(),
            detail: base_worktree_detail.clone(),
        });
    }
    if !invalid_worktrees.is_empty() {
        blocking_reasons.push(BlockingReason {
            code: "invalid_worktree_metadata".to_string(),
            detail: format!("{} invalid worktree(s)", invalid_worktrees.len()),
        });
    }
    if !missing_runtime_contract_worktrees.is_empty() {
        blocking_reasons.push(BlockingReason {
            code: "missing_worktree_runtime_contract".to_string(),
            detail: format!(
                "{} managed worktree(s) are missing .tmp/worktree-runtime-contract.json",
                missing_runtime_contract_worktrees.len()
            ),
        });
    }
    if !unregistered_managed_dirs.is_empty() {
        blocking_reasons.push(BlockingReason {
            code: "unregistered_worktree_dirs".to_string(),
            detail: format!(
                "{} managed wt dir(s) are not registered in git metadata",
                unregistered_managed_dirs.len()
            ),
        });
    }
    if !prunable_worktrees.is_empty() {
        blocking_reasons.push(BlockingReason {
            code: "prunable_worktree_metadata".to_string(),
            detail: format!(
                "{} prunable worktree metadata entrie(s)",
                prunable_worktrees.len()
            ),
        });
    }

    let next_action =
        build_next_action(&blocking_reasons, &unregistered_managed_dir_classifications);
    let recommended_phase = if blocking_reasons.is_empty() {
        "execute".to_string()
    } else {
        "close".to_string()
    };

    Ok(RepoSafetySummary {
        repo_root: repo_root.display().to_string(),
        base_branch: base_branch.to_string(),
        managed_worktree_root: managed_worktree_root.display().to_string(),
        base_worktree_clean,
        base_worktree_detail,
        registered_worktree_count,
        invalid_worktree_count: invalid_worktrees.len(),
        invalid_worktrees,
        missing_runtime_contract_worktree_count: missing_runtime_contract_worktrees.len(),
        missing_runtime_contract_worktrees,
        unregistered_managed_dir_count: unregistered_managed_dirs.len(),
        unregistered_managed_dirs: unregistered_managed_dirs
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        unregistered_managed_dir_disposition_counts,
        unregistered_managed_dir_classifications,
        prunable_worktree_count: prunable_worktrees.len(),
        prunable_worktrees,
        blocking_reasons,
        next_action,
        recommended_phase,
    })
}

fn evaluate_base_worktree_clean(repo_root: &Path) -> Result<(bool, String), String> {
    let result = run_command(repo_root, "git", ["status", "--porcelain", "-uall"])?;
    if result.status != 0 {
        return Ok((
            false,
            format!("git status failed: {}", command_detail(&result)),
        ));
    }
    let lines = result
        .stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Ok((true, "clean".to_string()));
    }
    let mut preview = lines.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
    let overflow = lines.len().saturating_sub(5);
    if overflow > 0 {
        preview.push_str(&format!(", ... (+{overflow} more)"));
    }
    Ok((false, format!("{} changed path(s): {preview}", lines.len())))
}

fn collect_invalid_worktree_classifications(
    repo_root: &Path,
    base_branch: &str,
) -> Result<Vec<RepoSafetyWorktreeClassification>, String> {
    let resolved_base_ref = resolve_base_ref(repo_root, base_branch)?
        .ok_or_else(|| format!("Base branch/ref not found: {base_branch}"))?;
    let base_branch_name = normalize_base_branch_name(&resolved_base_ref);
    let entries = parse_worktree_entries(repo_root)?;
    let mut invalid = Vec::new();
    for entry in entries {
        let Some(line) = classify_worktree_entry(
            repo_root,
            &resolved_base_ref,
            &base_branch_name,
            true,
            &entry,
        )?
        else {
            continue;
        };
        if !line.starts_with("4.main-invalid\t") {
            continue;
        }
        let parts = line.split('\t').collect::<Vec<_>>();
        if parts.len() < 6 {
            continue;
        }
        invalid.push(RepoSafetyWorktreeClassification {
            group: parts[0].to_string(),
            branch: parts[1].to_string(),
            ahead: parts[2]
                .trim_start_matches("ahead=")
                .parse::<i64>()
                .unwrap_or(0),
            behind: parts[3]
                .trim_start_matches("behind=")
                .parse::<i64>()
                .unwrap_or(0),
            worktree: parts[4].to_string(),
            merge_reason: parts[5].trim_start_matches("merge_reason=").to_string(),
        });
    }
    Ok(invalid)
}

fn resolve_managed_worktree_root(repo_root: &Path) -> Result<PathBuf, String> {
    let override_raw = env::var(MANAGED_WORKTREE_ROOT_ENV).unwrap_or_default();
    let override_text = override_raw.trim();
    if !override_text.is_empty() {
        let override_path = Path::new(override_text);
        let resolved = if override_path.is_absolute() {
            override_path.to_path_buf()
        } else {
            repo_root.join(override_path)
        };
        return if resolved.exists() {
            canonical_dir(&resolved)
        } else {
            Ok(resolved)
        };
    }
    Ok(repo_root
        .parent()
        .ok_or_else(|| "repository root has no parent directory".to_string())?
        .join("wt"))
}

fn collect_unregistered_managed_dirs(
    managed_worktree_root: &Path,
    worktree_entries: &[WorktreeEntry],
) -> Result<Vec<PathBuf>, String> {
    if !managed_worktree_root.is_dir() {
        return Ok(Vec::new());
    }
    let registered = worktree_entries
        .iter()
        .filter_map(|entry| canonical_dir(Path::new(&entry.path)).ok())
        .collect::<Vec<_>>();
    let mut entries = fs::read_dir(managed_worktree_root)
        .map_err(|error| {
            format!(
                "failed to read {}: {error}",
                managed_worktree_root.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "failed to read {}: {error}",
                managed_worktree_root.display()
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut unregistered = Vec::new();
    for entry in entries {
        if !entry
            .file_type()
            .map_err(|error| format!("failed to stat {}: {error}", entry.path().display()))?
            .is_dir()
        {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if !is_managed_worktree_dir_name(&dir_name) {
            continue;
        }
        let resolved = canonical_dir(&entry.path())?;
        if registered.iter().any(|path| path == &resolved) {
            continue;
        }
        unregistered.push(resolved);
    }
    Ok(unregistered)
}

fn classify_unregistered_managed_dir(
    worktree_path: &Path,
) -> Result<UnregisteredManagedDirClassification, String> {
    let resolved = canonical_dir(worktree_path)?;
    let (top_level_entries, scan_error) = collect_top_level_entry_names(&resolved);
    let preview_entries = top_level_entries
        .iter()
        .filter(|name| name.as_str() != ".git")
        .cloned()
        .collect::<Vec<_>>();
    let non_ephemeral_entries = preview_entries
        .iter()
        .filter(|name| !ephemeral_unregistered_top_level_names().contains(&name.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let git_entry = resolved.join(".git");
    let git_pointer = read_gitdir_pointer(&resolved);
    let resolved_text = resolved.display().to_string();
    let git_probe = run_command(
        &resolved,
        "git",
        [
            "-C",
            resolved_text.as_str(),
            "rev-parse",
            "--is-inside-work-tree",
        ],
    )?;
    let git_repo_valid = git_probe.status == 0 && git_probe.stdout.trim() == "true";
    let git_state = if git_repo_valid {
        "valid".to_string()
    } else if git_entry.exists() {
        "invalid".to_string()
    } else {
        "missing".to_string()
    };

    let broken_name = resolved
        .file_name()
        .map(|name| name.to_string_lossy().contains(BROKEN_WORKTREE_DIR_MARKER))
        .unwrap_or(false);
    let (disposition, reason) = if scan_error.is_some() {
        ("rescue".to_string(), "scan_error".to_string())
    } else if broken_name || git_state == "invalid" {
        (
            "broken_archive".to_string(),
            if broken_name {
                "broken_suffix".to_string()
            } else {
                "stale_git_metadata".to_string()
            },
        )
    } else if git_repo_valid {
        (
            "rescue".to_string(),
            "valid_git_repo_not_registered".to_string(),
        )
    } else if non_ephemeral_entries.is_empty() {
        ("delete".to_string(), "ephemeral_only".to_string())
    } else {
        (
            "rescue".to_string(),
            "contains_non_ephemeral_entries".to_string(),
        )
    };

    Ok(UnregisteredManagedDirClassification {
        worktree: resolved.display().to_string(),
        dir_name: resolved
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        disposition,
        reason,
        git_state,
        top_level_entry_count: preview_entries.len(),
        top_level_entries_preview: preview_entries
            .iter()
            .take(UNREGISTERED_DIR_PREVIEW_LIMIT)
            .cloned()
            .collect(),
        top_level_entries_overflow_count: preview_entries
            .len()
            .saturating_sub(UNREGISTERED_DIR_PREVIEW_LIMIT),
        gitdir_target: git_pointer,
        scan_error,
    })
}

fn collect_top_level_entry_names(worktree_path: &Path) -> (Vec<String>, Option<String>) {
    match fs::read_dir(worktree_path) {
        Ok(entries) => {
            let mut names = entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>();
            names.sort();
            (names, None)
        }
        Err(error) => (Vec::new(), Some(error.to_string())),
    }
}

fn read_gitdir_pointer(worktree_path: &Path) -> Option<String> {
    let git_path = worktree_path.join(".git");
    if !git_path.is_file() {
        return None;
    }
    let text = fs::read_to_string(git_path).ok()?;
    let first_line = text.lines().next()?.trim();
    if let Some(stripped) = first_line.strip_prefix("gitdir:") {
        return Some(stripped.trim().to_string());
    }
    Some(first_line.to_string())
}

fn summarize_disposition_counts(
    entries: &[UnregisteredManagedDirClassification],
) -> DispositionCounts {
    let mut counts = DispositionCounts {
        delete: 0,
        rescue: 0,
        broken_archive: 0,
    };
    for entry in entries {
        match entry.disposition.as_str() {
            "delete" => counts.delete += 1,
            "rescue" => counts.rescue += 1,
            "broken_archive" => counts.broken_archive += 1,
            _ => {}
        }
    }
    counts
}

fn collect_missing_runtime_contract_worktrees(
    managed_worktree_root: &Path,
    worktree_entries: &[WorktreeEntry],
    base_branch: &str,
) -> Result<Vec<MissingRuntimeContractWorktree>, String> {
    let main_branch_ref = format!("refs/heads/{base_branch}");
    let mut missing = Vec::new();
    for entry in worktree_entries {
        let worktree_path = canonical_dir(Path::new(&entry.path))?;
        if worktree_path.parent() != Some(managed_worktree_root) {
            continue;
        }
        let Some(dir_name) = worktree_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            continue;
        };
        if !is_managed_worktree_dir_name(&dir_name) {
            continue;
        }
        let branch_ref = if entry.branch.is_empty() {
            String::new()
        } else {
            format!("refs/heads/{}", entry.branch)
        };
        if branch_ref == main_branch_ref && !entry.detached {
            continue;
        }
        let contract_path = worktree_path.join(TASK_WORKTREE_RUNTIME_CONTRACT);
        if contract_path.is_file() {
            continue;
        }
        missing.push(MissingRuntimeContractWorktree {
            worktree: worktree_path.display().to_string(),
            branch: branch_ref,
            contract_path: contract_path.display().to_string(),
            detached: entry.detached,
        });
    }
    Ok(missing)
}

fn build_next_action(
    blocking_reasons: &[BlockingReason],
    unregistered_classifications: &[UnregisteredManagedDirClassification],
) -> String {
    if blocking_reasons.is_empty() {
        return String::new();
    }
    let codes = blocking_reasons
        .iter()
        .map(|entry| entry.code.as_str())
        .collect::<Vec<_>>();
    if codes.contains(&"invalid_worktree_metadata") {
        return "Run close and repair invalid git worktree metadata before any new execute run."
            .to_string();
    }
    if codes.contains(&"missing_worktree_runtime_contract") {
        return "Run close and recreate managed task worktrees through wt:start so each worktree has .tmp/worktree-runtime-contract.json.".to_string();
    }
    if codes.contains(&"unregistered_worktree_dirs") {
        let counts = summarize_disposition_counts(unregistered_classifications);
        let detail = [
            ("delete", counts.delete),
            ("rescue", counts.rescue),
            ("broken_archive", counts.broken_archive),
        ]
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(name, count)| format!("{name}={count}"))
        .collect::<Vec<_>>()
        .join(", ");
        if !detail.is_empty() {
            return format!(
                "Run close and resolve managed wt residue before any new execute run: {detail}."
            );
        }
        return "Run close and classify or archive managed wt directories that are not registered in git worktree metadata.".to_string();
    }
    if codes.contains(&"prunable_worktree_metadata") {
        return "Run close and prune stale git worktree metadata before any new execute run."
            .to_string();
    }
    if codes.contains(&"base_worktree_dirty") {
        return "Run close from the base main worktree and transfer residue off main before any new execute run.".to_string();
    }
    "Run close and resolve repo safety blockers before any new execute run.".to_string()
}

fn run_validate_pr_url(args: &[String]) -> Result<i32, String> {
    if args.is_empty() || args.len() > 2 {
        emit_invalid(
            "invalid_args",
            "usage: omta-orchestrator validate-pr-url <pr_url> [owner/repo]",
            None,
        );
        return Ok(1);
    }

    let pr_url = args[0].trim();
    let repo_arg = args.get(1).map(|value| value.trim()).unwrap_or("");
    if pr_url.is_empty() {
        emit_invalid(
            "missing_pr_url",
            "create or update a PR, then set pr_url",
            None,
        );
        return Ok(1);
    }
    if pr_url.starts_with("https://github.com/") && pr_url.contains("/pull/new/") {
        emit_invalid(
            "invalid_pr_url_format",
            "use the concrete PR URL (.../pull/<number>)",
            Some(pr_url),
        );
        return Ok(1);
    }

    let Some((url_repo, pr_number)) = parse_pr_url(pr_url) else {
        emit_invalid(
            "invalid_pr_url_format",
            "use https://github.com/<owner>/<repo>/pull/<number>",
            Some(pr_url),
        );
        return Ok(1);
    };

    if !repo_arg.is_empty() && repo_arg != url_repo {
        emit_invalid(
            "repo_mismatch",
            &format!("set PR URL for repo {repo_arg}"),
            Some(&format!("actual={url_repo} expected={repo_arg}")),
        );
        return Ok(1);
    }

    let cwd = env::current_dir().map_err(|error| format!("failed to resolve cwd: {error}"))?;
    let gh_check = run_command(&cwd, "gh", ["--version"]);
    if let Err(error) = gh_check {
        if error.contains("failed to run gh") {
            emit_invalid(
                "missing_command",
                "install gh",
                Some("gh command is required for PR existence check"),
            );
            return Ok(1);
        }
        return Err(error);
    }

    let gh_result = run_command(
        &cwd,
        "gh",
        [
            "api",
            &format!("repos/{url_repo}/pulls/{pr_number}"),
            "--jq",
            ".html_url",
        ],
    )?;
    if gh_result.status != 0 {
        emit_invalid(
            "pr_lookup_failed",
            "ensure PR exists and gh can access GitHub",
            Some(pr_url),
        );
        return Ok(1);
    }

    println!("status=valid");
    println!("failure_reason=none");
    println!("next_action=none");
    println!("repo={url_repo}");
    println!("pr_number={pr_number}");
    println!("pr_url={pr_url}");
    Ok(0)
}

fn emit_invalid(reason: &str, next_action: &str, detail: Option<&str>) {
    println!("status=invalid");
    println!("failure_reason={reason}");
    println!("next_action={next_action}");
    if let Some(detail) = detail.filter(|value| !value.is_empty()) {
        println!("detail={detail}");
    }
}

fn parse_pr_url(value: &str) -> Option<(String, String)> {
    let prefix = "https://github.com/";
    let stripped = value.strip_prefix(prefix)?;
    let parts = stripped.split('/').collect::<Vec<_>>();
    if parts.len() != 4 || parts[2] != "pull" || parts[0].is_empty() || parts[1].is_empty() {
        return None;
    }
    if parts[3].is_empty() || !parts[3].chars().all(|char| char.is_ascii_digit()) {
        return None;
    }
    Some((format!("{}/{}", parts[0], parts[1]), parts[3].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn usage_references_the_canonical_binary_contract() {
        let text = usage();
        assert!(text.contains("omta-orchestrator <command> [options]"));
        assert!(text.contains("bun run dev:tools:rust:build"));
        assert!(!text.contains("cargo run --manifest-path"));
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = env::temp_dir().join(format!("{prefix}-{unique}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn git(cwd: &Path, args: &[&str]) -> CmdResult {
        run_command(cwd, "git", args).expect("git command")
    }

    fn git_ok(cwd: &Path, args: &[&str]) -> String {
        let result = git(cwd, args);
        assert_eq!(
            result.status,
            0,
            "git {:?} failed: {}",
            args,
            command_detail(&result)
        );
        result.stdout
    }

    fn create_repo(root: &Path) -> PathBuf {
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init"]);
        git_ok(&repo, &["config", "user.name", "Test User"]);
        git_ok(&repo, &["config", "user.email", "test@example.com"]);
        git_ok(&repo, &["switch", "-c", "main"]);
        fs::write(repo.join("README.md"), "base\n").unwrap();
        git_ok(&repo, &["add", "README.md"]);
        git_ok(&repo, &["commit", "-m", "initial"]);
        repo
    }

    fn create_branch_commit(repo: &Path, branch: &str, relpath: &str, content: &str) {
        git_ok(repo, &["switch", "main"]);
        git_ok(repo, &["switch", "-c", branch]);
        let path = repo.join(relpath);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
        git_ok(repo, &["add", relpath]);
        git_ok(repo, &["commit", "-m", &format!("{branch} commit")]);
        git_ok(repo, &["switch", "main"]);
    }

    fn add_worktree(repo: &Path, wt_root: &Path, branch: &str) -> PathBuf {
        let wt = wt_root.join(branch.replace('/', "__"));
        git_ok(repo, &["worktree", "add", wt.to_str().unwrap(), branch]);
        wt
    }

    fn add_origin_remote(repo: &Path, root: &Path) -> PathBuf {
        let remote = root.join("origin.git");
        git_ok(root, &["init", "--bare", remote.to_str().unwrap()]);
        git_ok(repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git_ok(repo, &["push", "-u", "origin", "main"]);
        git_ok(
            repo,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/Omluc/omta.git",
            ],
        );
        remote
    }

    fn write_required_templates(repo: &Path) {
        let issue_template_dir = repo.join(".github").join("ISSUE_TEMPLATE");
        fs::create_dir_all(&issue_template_dir).unwrap();
        fs::write(
            repo.join(".github").join("PULL_REQUEST_TEMPLATE.md"),
            "template\n",
        )
        .unwrap();
        fs::write(issue_template_dir.join("task.yml"), "name: task\n").unwrap();
        git_ok(
            repo,
            &[
                "add",
                ".github/PULL_REQUEST_TEMPLATE.md",
                ".github/ISSUE_TEMPLATE/task.yml",
            ],
        );
        git_ok(repo, &["commit", "-m", "add required templates"]);
    }

    fn write_execution_plan(state_dir: &Path, repository: &str) {
        let inputs_dir = state_dir.join("inputs");
        fs::create_dir_all(&inputs_dir).unwrap();
        let task_scope = serde_json::json!({
            "owner_bucket": "tools",
            "owner_buckets": ["tools"],
            "conflict_class": "parallel-safe",
            "admission_mode": "standard",
            "global_invariant": "",
            "unfreeze_condition": "",
            "verification_class": "full-build-sensitive",
            "scope_gate_keys": ["task-governance"],
            "serialized_scope_keys": ["task_governance_control_plane"],
            "hot_root_paths": [],
            "resource_claims": [
                {
                    "mode": "exclusive",
                    "resource": "execution-plan-writer"
                }
            ]
        });
        let node = serde_json::json!({
            "id": "OPS-260325180000",
            "issue_node_id": "NODE_OPS-260325180000",
            "branch": "task/ops-260325180000-replace-orchestrate-dag-runtime",
            "priority": 1,
            "deps": [],
            "github_issue": format!("https://github.com/{repository}/issues/100"),
            "scope": "tools/orchestrator/**",
            "allowed_files": ["tools/orchestrator/**"],
            "commit_units": ["CU1: bootstrap runtime state from execution plan"],
            "non_goals": [],
            "acceptance_checks": ["cargo test --manifest-path tools/orchestrator/Cargo.toml"],
            "tests": ["cargo test --manifest-path tools/orchestrator/Cargo.toml"],
            "covers": ["OPS-260325180000"],
            "instructions": "Run only the listed commands.",
            "task_scope": task_scope
        });
        fs::write(
            inputs_dir.join("execution-plan.json"),
            serde_json::json!({
                "base_branch": "main",
                "max_workers": 4,
                "merge_mode": "remote-pr",
                "merge_queue": false,
                "cleanup": true,
                "queue_strategy": "dag_priority",
                "require_passing_tests": true,
                "require_traceability": true,
                "require_acceptance_checks": true,
                "issue_tracking": {
                    "strategy": "remote-github-sot",
                    "repository": repository,
                    "node_issue_mode": "per-node",
                    "progress_issue_number": 0,
                    "progress_issue_url": "",
                },
                "source_items": [
                    {
                        "id": "OPS-260325180000",
                        "verdict": "valid",
                        "summary": "OPS-260325180000: bootstrap runtime state from execution plan",
                        "github_issue": format!("https://github.com/{repository}/issues/100")
                    }
                ],
                "issue_map": {
                    "OPS-260325180000": format!("https://github.com/{repository}/issues/100")
                },
                "deferred_items": [],
                "nodes": [node]
            })
            .to_string(),
        )
        .unwrap();
    }

    fn manifest_path() -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("Cargo.toml")
            .to_string_lossy()
            .into_owned()
    }

    fn run_binary_with_env(
        cwd: &Path,
        args: &[&str],
        extra_path: Option<&Path>,
        extra_env: &[(&str, &str)],
    ) -> CmdResult {
        let mut command = Command::new("cargo");
        command.args([
            "run",
            "--quiet",
            "--manifest-path",
            manifest_path().as_str(),
            "--",
        ]);
        command.args(args);
        command.current_dir(cwd);
        if let Some(extra_path) = extra_path {
            let existing_path = env::var("PATH").unwrap_or_default();
            command.env(
                "PATH",
                format!("{}:{}", extra_path.display(), existing_path),
            );
        }
        for (key, value) in extra_env {
            command.env(key, value);
        }
        let output = command.output().expect("run binary");
        CmdResult {
            status: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }
    }

    fn run_binary(cwd: &Path, args: &[&str], extra_path: Option<&Path>) -> CmdResult {
        run_binary_with_env(cwd, args, extra_path, &[])
    }

    fn run_repo_safety_json(repo_root: &Path, extra_args: &[&str]) -> Value {
        let mut args = vec![
            "repo-safety",
            "--repo-root",
            repo_root.to_str().unwrap(),
            "--base-branch",
            "main",
        ];
        args.extend_from_slice(extra_args);
        let result = run_binary(repo_root, &args, None);
        assert_eq!(result.status, 0, "{}", command_detail(&result));
        serde_json::from_str(&result.stdout).expect("repo safety json")
    }

    #[test]
    fn worktree_classify_reports_expected_groups() {
        let root = temp_dir("orchestrator-classify");
        let repo = create_repo(&root);
        let wt_root = root.join("wt");
        fs::create_dir_all(&wt_root).unwrap();

        create_branch_commit(&repo, "task/unmerged-clean", "clean.txt", "clean\n");
        add_worktree(&repo, &wt_root, "task/unmerged-clean");

        create_branch_commit(&repo, "task/unmerged-dirty", "dirty.txt", "dirty\n");
        let dirty_wt = add_worktree(&repo, &wt_root, "task/unmerged-dirty");
        fs::write(dirty_wt.join("untracked.txt"), "dirty\n").unwrap();

        let result = run_binary(&repo, &["worktree-classify", "--base", "main"], None);
        assert_eq!(result.status, 0, "{}", command_detail(&result));
        assert!(
            result
                .stdout
                .contains("1.main-unmerged-clean\ttask/unmerged-clean\t"),
            "{}",
            result.stdout
        );
        assert!(
            result
                .stdout
                .contains("2.main-unmerged-dirty\ttask/unmerged-dirty\t"),
            "{}",
            result.stdout
        );
    }

    #[test]
    fn validate_pr_url_succeeds_with_fake_gh() {
        let root = temp_dir("orchestrator-validate");
        let bin_dir = root.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let gh_path = bin_dir.join("gh");
        fs::write(
            &gh_path,
            "#!/usr/bin/env bash\nset -euo pipefail\nif [[ \"${1:-}\" == \"--version\" ]]; then echo gh; exit 0; fi\nif [[ \"${1:-}\" == \"api\" ]]; then echo https://github.com/Omluc/omta/pull/42; exit 0; fi\nexit 1\n",
        )
        .unwrap();
        let mut perms = fs::metadata(&gh_path).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
            fs::set_permissions(&gh_path, perms).unwrap();
        }

        let result = run_binary(
            &root,
            &[
                "validate-pr-url",
                "https://github.com/Omluc/omta/pull/42",
                "Omluc/omta",
            ],
            Some(&bin_dir),
        );
        assert_eq!(result.status, 0, "{}", command_detail(&result));
        assert!(result.stdout.contains("status=valid"), "{}", result.stdout);
    }

    #[test]
    fn preflight_repo_safety_blocks_dirty_base() {
        let root = temp_dir("orchestrator-preflight");
        let repo = create_repo(&root);
        fs::write(repo.join("README.md"), "dirty\n").unwrap();
        let previous_cwd = env::current_dir().unwrap();
        env::set_current_dir(&repo).unwrap();
        let code = run_preflight_repo_safety(&[]).expect("preflight");
        env::set_current_dir(previous_cwd).unwrap();
        assert_eq!(code, 1);
    }

    #[test]
    fn repo_safety_allows_clean_repo() {
        let root = temp_dir("orchestrator-repo-safety-clean");
        let repo = create_repo(&root);
        let summary = run_repo_safety_json(&repo, &[]);
        assert_eq!(summary["recommended_phase"], "execute");
        assert_eq!(summary["base_worktree_clean"], true);
        assert_eq!(summary["invalid_worktree_count"], 0);
        assert_eq!(summary["unregistered_managed_dir_count"], 0);
    }

    #[test]
    fn repo_safety_blocks_dirty_base_without_override() {
        let root = temp_dir("orchestrator-repo-safety-dirty");
        let repo = create_repo(&root);
        fs::write(repo.join("README.md"), "dirty\n").unwrap();
        let summary = run_repo_safety_json(&repo, &[]);
        let bypassed = run_repo_safety_json(&repo, &["--allow-dirty-base"]);
        assert_eq!(summary["recommended_phase"], "close");
        assert_eq!(bypassed["recommended_phase"], "execute");
    }

    #[test]
    fn repo_safety_blocks_unregistered_managed_worktree_dirs() {
        let root = temp_dir("orchestrator-repo-safety-unregistered");
        let repo = create_repo(&root);
        fs::create_dir_all(root.join("wt").join("OPS-260311174540")).unwrap();
        let summary = run_repo_safety_json(&repo, &[]);
        assert_eq!(summary["recommended_phase"], "close");
        assert_eq!(summary["unregistered_managed_dir_count"], 1);
        assert_eq!(
            summary["unregistered_managed_dir_disposition_counts"]["delete"],
            1
        );
    }

    #[test]
    fn repo_safety_blocks_registered_task_worktree_without_runtime_contract() {
        let root = temp_dir("orchestrator-repo-safety-runtime-contract");
        let repo = create_repo(&root);
        let wt_root = root.join("wt");
        fs::create_dir_all(&wt_root).unwrap();
        create_branch_commit(
            &repo,
            "task/ops-260311174540-runtime-contract",
            "runtime-contract.txt",
            "missing contract\n",
        );
        let wt_path = wt_root.join("OPS-260311174540");
        git_ok(
            &repo,
            &[
                "worktree",
                "add",
                wt_path.to_str().unwrap(),
                "task/ops-260311174540-runtime-contract",
            ],
        );
        let summary = run_repo_safety_json(&repo, &[]);
        assert_eq!(summary["recommended_phase"], "close");
        assert_eq!(summary["missing_runtime_contract_worktree_count"], 1);
    }

    #[test]
    fn repo_safety_uses_origin_main_when_local_main_ref_is_missing() {
        let root = temp_dir("orchestrator-repo-safety-origin-main");
        let repo = create_repo(&root);
        let _remote = add_origin_remote(&repo, &root);
        git_ok(&repo, &["switch", "--detach", "HEAD"]);
        git_ok(&repo, &["branch", "-D", "main"]);
        let summary = run_repo_safety_json(&repo, &[]);
        assert_eq!(summary["recommended_phase"], "execute");
        assert_eq!(summary["invalid_worktree_count"], 0);
    }

    #[test]
    fn doctor_passes_with_valid_execution_plan_inputs() {
        let root = temp_dir("orchestrator-doctor-pass");
        let repo = create_repo(&root);
        let _remote = add_origin_remote(&repo, &root);
        write_required_templates(&repo);
        let state_dir = root
            .join("wt")
            .join(".omta")
            .join("state")
            .join("sessions")
            .join("sess-20260325120000-abc12345");
        write_execution_plan(&state_dir, "Omluc/omta");

        let result = run_binary_with_env(
            &repo,
            &[
                "doctor",
                "--repo-root",
                repo.to_str().unwrap(),
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--session-id",
                "sess-20260325120000-abc12345",
                "--state-backend",
                "local",
            ],
            None,
            &[("GH_TOKEN", "test-token")],
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        assert!(
            result.stdout.contains("Doctor checks passed"),
            "{}",
            result.stdout
        );
    }

    #[test]
    fn parse_run_options_preserves_requested_state_backend() {
        let root = temp_dir("orchestrator-run-options");
        let options = parse_run_options(&[
            "--repo-root".to_string(),
            root.display().to_string(),
            "--state-dir".to_string(),
            root.join("state").display().to_string(),
            "--session-id".to_string(),
            "sess-20260326000000-abc12345".to_string(),
            "--state-backend".to_string(),
            "local".to_string(),
        ])
        .expect("run options");
        assert_eq!(options.state_backend, "local");
    }

    #[test]
    fn load_resolved_run_config_reports_selected_profile() {
        let root = temp_dir("orchestrator-resolved-run-config");
        let config_path = root.join("skills.config.json");
        fs::write(
            &config_path,
            serde_json::json!({
                "orchestrate": {
                    "default_profile": "deep-review",
                    "defaults": {
                        "writing_language": "ja"
                    },
                    "profiles": {
                        "deep-review": {
                            "writing_language": "en"
                        }
                    }
                }
            })
            .to_string(),
        )
        .expect("write skills config");
        let options = RunOptions {
            repo_root: root.clone(),
            state_dir: root.join("state"),
            session_id: "sess-20260326000000-abc12346".to_string(),
            state_backend: "github".to_string(),
            skills_config: config_path.display().to_string(),
            profile: String::new(),
        };
        let config = load_resolved_run_config(&options).expect("resolved config");
        assert_eq!(config.selected_profile, "deep-review");
        assert_eq!(config.writing_language, "en");
    }

    #[test]
    fn load_resolved_run_config_rejects_unknown_profile_keys() {
        let root = temp_dir("orchestrator-resolved-run-config-unknown-key");
        let config_path = root.join("skills.config.toml");
        fs::write(
            &config_path,
            r#"
["orchestrate"]
default_profile = "remote-pr-default"

["orchestrate".defaults]
spawn_mode = "child-exec"

["orchestrate".profiles."remote-pr-default"]
auto_approve = true

["orchestrate".profiles."remote-pr-default".worktree_gate]
enabled = true
include_default_checks = false
"#,
        )
        .expect("write skills config");
        let options = RunOptions {
            repo_root: root.clone(),
            state_dir: root.join("state"),
            session_id: "sess-20260326000000-unknownkey".to_string(),
            state_backend: "github".to_string(),
            skills_config: config_path.display().to_string(),
            profile: String::new(),
        };
        let error = load_resolved_run_config(&options).expect_err("unknown keys must fail closed");
        assert!(error.contains("include_default_checks"), "{error}");
    }

    #[test]
    fn load_resolved_run_config_accepts_runtime_supported_toml_surface() {
        let root = temp_dir("orchestrator-resolved-run-config-supported-toml");
        let config_path = root.join("skills.config.toml");
        fs::write(
            &config_path,
            r#"
["orchestrate"]
default_profile = "claude-execute"

["orchestrate".defaults]
spawn_mode = "child-exec"
cleanup = true
require_passing_tests = true
require_acceptance_checks = true
require_worktree_setup = true
setup_worktree_cmd = "bun install --frozen-lockfile --backend clonefile --linker hoisted"
writing_language = "ja"

["orchestrate".defaults.child_exec]
cmd = "claude"
args = "--dangerously-skip-permissions"

["orchestrate".defaults.runtime_policy]
max_runtime_seconds = 3600
stuck_timeout_seconds = 300

["orchestrate".profiles."claude-execute"]
spawn_mode = "command"
auto_approve = true
writing_language = "en"

["orchestrate".profiles."claude-execute".command_exec]
agent_cmd = "claude -p \"$(cat '{task_file}')\" --dangerously-skip-permissions"

["orchestrate".profiles."claude-execute".worktree_gate]
enabled = true
mode = "node-scope"
fail_on_unmapped_scope = true

["orchestrate".profiles."claude-execute".worktree_gate.scope_gate_cmds]
ops = "bun run check:skill-runtime"
"#,
        )
        .expect("write skills config");
        let options = RunOptions {
            repo_root: root.clone(),
            state_dir: root.join("state"),
            session_id: "sess-20260326000000-supported".to_string(),
            state_backend: "github".to_string(),
            skills_config: config_path.display().to_string(),
            profile: String::new(),
        };
        let config = load_resolved_run_config(&options).expect("resolved config");
        assert_eq!(config.selected_profile, "claude-execute");
        assert_eq!(config.spawn_mode, "command");
        assert_eq!(
            config.command_exec_agent_cmd,
            "claude -p \"$(cat '{task_file}')\" --dangerously-skip-permissions"
        );
        assert!(config.worktree_gate_enabled);
        assert_eq!(config.worktree_gate_mode, "node-scope");
        assert_eq!(
            config
                .worktree_scope_gate_cmds
                .get("ops")
                .map(String::as_str),
            Some("bun run check:skill-runtime")
        );
        assert_eq!(config.writing_language, "en");
    }

    #[test]
    fn doctor_fails_closed_when_execution_plan_is_missing() {
        let root = temp_dir("orchestrator-doctor-missing-plan");
        let repo = create_repo(&root);
        let state_dir = root
            .join("wt")
            .join(".omta")
            .join("state")
            .join("sessions")
            .join("sess-20260325120000-missing00");
        fs::create_dir_all(&state_dir).unwrap();
        let result = run_binary(
            &repo,
            &[
                "doctor",
                "--repo-root",
                repo.to_str().unwrap(),
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--session-id",
                "sess-20260325120000-missing00",
                "--state-backend",
                "local",
            ],
            None,
        );

        assert_eq!(result.status, 1, "{}", result.stdout);
        assert!(
            command_detail(&result).contains("execution-plan.json"),
            "{}",
            command_detail(&result)
        );
    }

    #[test]
    fn state_bootstrap_writes_initial_state_from_execution_plan() {
        let root = temp_dir("orchestrator-state-bootstrap-initial");
        let repo = create_repo(&root);
        let state_dir = root
            .join("wt")
            .join(".omta")
            .join("state")
            .join("sessions")
            .join("sess-20260325120000-bootstrap0");
        write_execution_plan(&state_dir, "Omluc/omta");

        let result = run_binary(
            &repo,
            &[
                "state-bootstrap",
                "--repo-root",
                repo.to_str().unwrap(),
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--session-id",
                "sess-20260325120000-bootstrap0",
                "--state-backend",
                "github",
                "--run-issue",
                "77",
            ],
            None,
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        let state_path = state_dir.join("state.json");
        assert_eq!(
            result.stdout.trim(),
            fs::canonicalize(&state_path).unwrap().display().to_string()
        );
        let payload: Value =
            serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
        assert_eq!(
            payload["nodes"]["OPS-260325180000"]["status"],
            Value::String("pending".to_string())
        );
        assert_eq!(
            payload["nodes"]["OPS-260325180000"]["branch"],
            Value::String("task/ops-260325180000-replace-orchestrate-dag-runtime".to_string())
        );
        assert_eq!(
            payload["github_state"]["state_backend"],
            Value::String("github".to_string())
        );
        assert_eq!(
            payload["github_state"]["repository"],
            Value::String("Omluc/omta".to_string())
        );
        assert_eq!(payload["github_state"]["run_issue_number"], Value::from(77));
        assert_eq!(
            payload["github_state"]["run_issue_url"],
            Value::String("https://github.com/Omluc/omta/issues/77".to_string())
        );
        assert_eq!(
            payload["runtime"]["session_id"],
            Value::String("sess-20260325120000-bootstrap0".to_string())
        );
        assert_eq!(
            payload["runtime"]["repo_root"],
            Value::String(fs::canonicalize(&repo).unwrap().display().to_string())
        );
    }

    #[test]
    fn state_bootstrap_recovers_running_node_into_canonical_state() {
        let root = temp_dir("orchestrator-state-bootstrap-recover");
        let repo = create_repo(&root);
        let state_dir = root
            .join("wt")
            .join(".omta")
            .join("state")
            .join("sessions")
            .join("sess-20260325120000-bootstrap1");
        write_execution_plan(&state_dir, "Omluc/omta");
        let worktree_path = root.join("executor").join("OPS-260325180000");
        fs::create_dir_all(worktree_path.join(".orchestrator").join("status")).unwrap();
        fs::write(
            worktree_path
                .join(".orchestrator")
                .join("status")
                .join("OPS-260325180000.json"),
            serde_json::json!({
                "node_id": "OPS-260325180000",
                "status": "ready_for_review",
                "summary": "child finished"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            state_dir.join("state.json"),
            serde_json::json!({
                "updated_at": "2026-03-25T12:00:00Z",
                "nodes": {
                    "OPS-260325180000": {
                        "status": "running",
                        "branch": "task/ops-260325180000-replace-orchestrate-dag-runtime",
                        "deps": [],
                        "worktree": worktree_path.display().to_string(),
                        "last_update": "2026-03-25T12:00:00Z"
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let result = run_binary(
            &repo,
            &[
                "state-bootstrap",
                "--repo-root",
                repo.to_str().unwrap(),
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--session-id",
                "sess-20260325120000-bootstrap1",
                "--state-backend",
                "local",
            ],
            None,
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        let payload: Value =
            serde_json::from_str(&fs::read_to_string(state_dir.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(
            payload["nodes"]["OPS-260325180000"]["status"],
            Value::String("ready_for_review".to_string())
        );
        assert_eq!(
            payload["nodes"]["OPS-260325180000"]["worktree_prepared"],
            Value::Bool(false)
        );
        assert_eq!(
            payload["github_state"]["run_id"],
            Value::String(String::new())
        );
    }

    #[test]
    fn review_decision_rework_resets_node_and_prunes_queue() {
        let root = temp_dir("orchestrator-review-rework");
        let repo = create_repo(&root);
        let state_dir = root.join("state");
        fs::create_dir_all(state_dir.join("review")).unwrap();
        fs::create_dir_all(state_dir.join("status")).unwrap();
        fs::write(state_dir.join("status").join("OPS-1.json"), "{}").unwrap();
        fs::write(
            state_dir.join("review").join("OPS-1.json"),
            serde_json::json!({
                "decision": "rework",
                "summary": "fix reviewer findings"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            state_dir.join("state.json"),
            serde_json::json!({
                "updated_at": "2026-03-25T12:00:00Z",
                "nodes": {
                    "OPS-1": {
                        "status": "ready_for_review",
                        "attempts": 0,
                        "branch": "task/ops-1",
                        "deps": []
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            state_dir.join("merge-queue.json"),
            serde_json::json!([{ "node_id": "OPS-1" }, { "node_id": "OPS-2" }]).to_string(),
        )
        .unwrap();

        let result = run_binary(
            &repo,
            &[
                "review-decision",
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--node-id",
                "OPS-1",
                "--merge-queue",
            ],
            None,
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        let state: Value =
            serde_json::from_str(&fs::read_to_string(state_dir.join("state.json")).unwrap())
                .unwrap();
        let queue: Value =
            serde_json::from_str(&fs::read_to_string(state_dir.join("merge-queue.json")).unwrap())
                .unwrap();
        assert_eq!(
            state["nodes"]["OPS-1"]["status"],
            Value::String("pending".to_string())
        );
        assert_eq!(state["nodes"]["OPS-1"]["attempts"], Value::from(1));
        assert_eq!(
            state["nodes"]["OPS-1"]["last_failure_reason"],
            Value::String("review_rework_requested".to_string())
        );
        assert_eq!(queue, serde_json::json!([{ "node_id": "OPS-2" }]));
        assert!(!state_dir.join("status").join("OPS-1.json").exists());
        assert!(!state_dir.join("review").join("OPS-1.json").exists());
    }

    #[test]
    fn review_decision_reject_blocks_node_and_writes_status() {
        let root = temp_dir("orchestrator-review-reject");
        let repo = create_repo(&root);
        let state_dir = root.join("state");
        fs::create_dir_all(state_dir.join("review")).unwrap();
        fs::write(
            state_dir.join("review").join("OPS-1.json"),
            serde_json::json!({
                "decision": "reject",
                "summary": "review found a regression",
                "escalation": {
                    "level": "manual",
                    "reason": "needs manual intervention"
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            state_dir.join("state.json"),
            serde_json::json!({
                "updated_at": "2026-03-25T12:00:00Z",
                "nodes": {
                    "OPS-1": {
                        "status": "ready_for_review",
                        "attempts": 1,
                        "branch": "task/ops-1",
                        "deps": []
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let result = run_binary(
            &repo,
            &[
                "review-decision",
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--node-id",
                "OPS-1",
            ],
            None,
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        let state: Value =
            serde_json::from_str(&fs::read_to_string(state_dir.join("state.json")).unwrap())
                .unwrap();
        let status: Value = serde_json::from_str(
            &fs::read_to_string(state_dir.join("status").join("OPS-1.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            state["nodes"]["OPS-1"]["status"],
            Value::String("blocked".to_string())
        );
        assert_eq!(
            state["nodes"]["OPS-1"]["blocked_reason"],
            Value::String("review_rejected".to_string())
        );
        assert_eq!(
            state["nodes"]["OPS-1"]["escalation_reason"],
            Value::String("needs manual intervention".to_string())
        );
        assert_eq!(
            status["failure_reason"],
            Value::String("review_rejected".to_string())
        );
        assert_eq!(
            status["review"]["decision"],
            Value::String("reject".to_string())
        );
    }

    #[test]
    fn review_decision_auto_approve_returns_approve_without_status_file() {
        let root = temp_dir("orchestrator-review-approve");
        let repo = create_repo(&root);
        let state_dir = root.join("state");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("state.json"),
            serde_json::json!({
                "updated_at": "2026-03-25T12:00:00Z",
                "nodes": {
                    "OPS-1": {
                        "status": "ready_for_review",
                        "attempts": 1,
                        "branch": "task/ops-1",
                        "deps": []
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let result = run_binary(
            &repo,
            &[
                "review-decision",
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--node-id",
                "OPS-1",
                "--auto-approve",
            ],
            None,
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        let payload: Value = serde_json::from_str(result.stdout.trim()).unwrap();
        let state: Value =
            serde_json::from_str(&fs::read_to_string(state_dir.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(payload["decision"], Value::String("approve".to_string()));
        assert_eq!(
            state["nodes"]["OPS-1"]["status"],
            Value::String("ready_for_review".to_string())
        );
        assert!(!state_dir.join("status").join("OPS-1.json").exists());
        assert_eq!(
            serde_json::from_str::<Value>(
                &fs::read_to_string(state_dir.join("review").join("OPS-1.json")).unwrap()
            )
            .unwrap()["decision"],
            Value::String("approve".to_string())
        );
    }

    #[test]
    fn schedule_retry_reschedules_node_and_clears_iteration_artifacts() {
        let root = temp_dir("orchestrator-schedule-retry-pending");
        let repo = create_repo(&root);
        let state_dir = root.join("state");
        fs::create_dir_all(state_dir.join("status")).unwrap();
        fs::create_dir_all(state_dir.join("review")).unwrap();
        fs::write(state_dir.join("status").join("OPS-1.json"), "{}").unwrap();
        fs::write(state_dir.join("review").join("OPS-1.json"), "{}").unwrap();
        fs::write(
            state_dir.join("state.json"),
            serde_json::json!({
                "updated_at": "2026-03-25T12:00:00Z",
                "nodes": {
                    "OPS-1": {
                        "status": "running",
                        "attempts": 0,
                        "branch": "task/ops-1",
                        "deps": []
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let result = run_binary(
            &repo,
            &[
                "schedule-retry",
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--node-id",
                "OPS-1",
                "--summary",
                "node became stuck",
                "--failure-reason",
                "node_stuck_timeout",
                "--now-iso",
                "2026-02-15T00:00:00Z",
                "--max-retries",
                "3",
                "--backoff-base",
                "10",
                "--backoff-factor",
                "2",
                "--backoff-max",
                "300",
            ],
            None,
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        let payload: Value = serde_json::from_str(result.stdout.trim()).unwrap();
        let state: Value =
            serde_json::from_str(&fs::read_to_string(state_dir.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(payload["retry_scheduled"], Value::Bool(true));
        assert_eq!(
            state["nodes"]["OPS-1"]["status"],
            Value::String("pending".to_string())
        );
        assert_eq!(state["nodes"]["OPS-1"]["attempts"], Value::from(1));
        assert_eq!(
            state["nodes"]["OPS-1"]["retry_ready_at"],
            Value::String("2026-02-15T00:00:10Z".to_string())
        );
        assert!(!state_dir.join("status").join("OPS-1.json").exists());
        assert!(!state_dir.join("review").join("OPS-1.json").exists());
    }

    #[test]
    fn schedule_retry_blocks_node_when_retry_budget_is_exhausted() {
        let root = temp_dir("orchestrator-schedule-retry-blocked");
        let repo = create_repo(&root);
        let state_dir = root.join("state");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("state.json"),
            serde_json::json!({
                "updated_at": "2026-03-25T12:00:00Z",
                "nodes": {
                    "OPS-1": {
                        "status": "running",
                        "attempts": 2,
                        "branch": "task/ops-1",
                        "deps": []
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let result = run_binary(
            &repo,
            &[
                "schedule-retry",
                "--state-dir",
                state_dir.to_str().unwrap(),
                "--node-id",
                "OPS-1",
                "--summary",
                "node exceeded max runtime",
                "--failure-reason",
                "node_max_runtime_exceeded",
                "--now-iso",
                "2026-02-15T00:00:00Z",
                "--max-retries",
                "3",
                "--backoff-base",
                "10",
                "--backoff-factor",
                "2",
                "--backoff-max",
                "300",
                "--extra-json",
                "{\"source\":\"unit-test\"}",
            ],
            None,
        );

        assert_eq!(result.status, 0, "{}", command_detail(&result));
        let payload: Value = serde_json::from_str(result.stdout.trim()).unwrap();
        let state: Value =
            serde_json::from_str(&fs::read_to_string(state_dir.join("state.json")).unwrap())
                .unwrap();
        let status: Value = serde_json::from_str(
            &fs::read_to_string(state_dir.join("status").join("OPS-1.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["retry_scheduled"], Value::Bool(false));
        assert_eq!(
            state["nodes"]["OPS-1"]["status"],
            Value::String("blocked".to_string())
        );
        assert_eq!(
            state["nodes"]["OPS-1"]["retry_exhausted_at"],
            Value::String("2026-02-15T00:00:00Z".to_string())
        );
        assert_eq!(status["retry"]["exhausted"], Value::Bool(true));
        assert_eq!(status["source"], Value::String("unit-test".to_string()));
    }
}
