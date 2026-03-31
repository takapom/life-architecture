import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOrchestratorRuntimeEnv,
  buildSessionId,
  resolveRuntimeStateDir,
  resolveSessionId,
  resolveStateBackend,
} from "./execute_runtime";

const repoRoot = path.resolve(import.meta.dir, "../../../../");
const scriptPath = path.resolve(import.meta.dir, "execute_runtime.ts");

test("execute_runtime help describes doctor as the execution-plan compile gate", () => {
  const run = spawnSync("bun", [scriptPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  expect(run.status).toBe(0);
  expect(`${run.stdout}`).toContain(
    "doctor compiles and validates the execution plan from GitHub task issues"
  );
  expect(`${run.stdout}`).not.toContain("validate-bundle");
});

test("execute_runtime rejects removed validate-bundle command", () => {
  const run = spawnSync("bun", [scriptPath, "validate-bundle"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  expect(run.status).toBe(1);
  expect(`${run.stderr}`).toContain("unknown command: validate-bundle");
});

test("resolveStateBackend defaults to github", () => {
  expect(resolveStateBackend("")).toBe("github");
});

test("resolveStateBackend accepts explicit local backend", () => {
  expect(resolveStateBackend("local")).toBe("local");
});

test("resolveRuntimeStateDir uses explicit path when state-dir is provided", () => {
  const resolved = resolveRuntimeStateDir(
    repoRoot,
    "../wt/.omta/state/sessions/sess-20260217000000-abcd1234-debug",
    "sess-20260217000000-abcd1234"
  );
  expect(resolved).toBe(
    path.resolve("../wt/.omta/state/sessions/sess-20260217000000-abcd1234-debug")
  );
});

test("resolveSessionId accepts explicit value", () => {
  expect(resolveSessionId("sess-20260217-abcd1234")).toBe("sess-20260217-abcd1234");
});

test("resolveSessionId generates fallback when value is empty", () => {
  const resolved = resolveSessionId("", buildSessionId(new Date("2026-02-17T00:00:00Z")));
  expect(resolved.startsWith("sess-20260217000000-")).toBe(true);
});

test("resolveSessionId rejects invalid value", () => {
  expect(() => resolveSessionId("sess/invalid")).toThrow("invalid session id");
});

test("resolveRuntimeStateDir uses deterministic persistent default path", () => {
  const sessionId = "sess-20260217000000-abcd1234";
  const resolved = resolveRuntimeStateDir(repoRoot, "", sessionId);
  expect(resolved.includes(path.join("wt", ".omta", "state", "sessions", sessionId))).toBe(true);
  expect(existsSync(resolved)).toBe(true);

  rmSync(resolved, { recursive: true, force: true });
});

test("resolveRuntimeStateDir rejects paths outside worktree root", () => {
  expect(() =>
    resolveRuntimeStateDir(
      repoRoot,
      path.resolve(repoRoot, "apps", "api", ".tmp", "invalid"),
      "sess-20260217000000-abcd1234"
    )
  ).toThrow("--state-dir must be under");
});

test("resolveRuntimeStateDir rejects paths under git common dir", () => {
  const gitCommonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).stdout.trim();
  const gitCommonDirAbs = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(repoRoot, gitCommonDir);
  expect(() =>
    resolveRuntimeStateDir(
      repoRoot,
      path.join(gitCommonDirAbs, "orchestrator", "sessions", "sess-20260217000000-abcd1234"),
      "sess-20260217000000-abcd1234"
    )
  ).toThrow("--state-dir must not be under git common dir");
});

test("buildOrchestratorRuntimeEnv sets deterministic temp env for run mode", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "execute-orch-tmp-"));
  try {
    const env = buildOrchestratorRuntimeEnv(repoRoot, {
      ...process.env,
      ORCHESTRATE_TMPDIR: tempRoot,
      TMPDIR: "",
      TMP: "",
      TEMP: "",
      BUN_TMPDIR: "",
      npm_config_tmp: "",
      OMTA_SKIP_GIT_HOOKS: "",
    });
    expect(env.TMPDIR).toBe(tempRoot);
    expect(env.TMP).toBe(tempRoot);
    expect(env.TEMP).toBe(tempRoot);
    expect(env.BUN_TMPDIR).toBe(path.join(tempRoot, "bun"));
    expect(env.npm_config_tmp).toBe(path.join(tempRoot, "npm"));
    expect(env.OMTA_SKIP_GIT_HOOKS).toBe("1");
    expect(env.ORCHESTRATE_SESSION_ID).toBeTruthy();
    expect(existsSync(path.join(tempRoot, "bun"))).toBe(true);
    expect(existsSync(path.join(tempRoot, "npm"))).toBe(true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildOrchestratorRuntimeEnv preserves explicit temp env overrides", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "execute-orch-custom-"));
  const tmpdir = path.join(tempRoot, "tmp");
  const bunTmp = path.join(tempRoot, "bun-custom");
  const npmTmp = path.join(tempRoot, "npm-custom");
  try {
    const env = buildOrchestratorRuntimeEnv(repoRoot, {
      ...process.env,
      TMPDIR: tmpdir,
      TMP: tmpdir,
      TEMP: tmpdir,
      BUN_TMPDIR: bunTmp,
      npm_config_tmp: npmTmp,
      OMTA_SKIP_GIT_HOOKS: "0",
    });
    expect(env.TMPDIR).toBe(tmpdir);
    expect(env.BUN_TMPDIR).toBe(bunTmp);
    expect(env.npm_config_tmp).toBe(npmTmp);
    expect(env.OMTA_SKIP_GIT_HOOKS).toBe("0");
    expect(env.ORCHESTRATE_SESSION_ID).toBeTruthy();
    expect(existsSync(tmpdir)).toBe(true);
    expect(existsSync(bunTmp)).toBe(true);
    expect(existsSync(npmTmp)).toBe(true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildOrchestratorRuntimeEnv honors explicit session id", () => {
  const env = buildOrchestratorRuntimeEnv(
    repoRoot,
    {
      ...process.env,
      ORCHESTRATE_TMPDIR: "",
      ORCHESTRATE_SESSION_ID: "",
      TMPDIR: "",
      TMP: "",
      TEMP: "",
      BUN_TMPDIR: "",
      npm_config_tmp: "",
    },
    "sess-20260217-abc12345"
  );
  expect(env.ORCHESTRATE_SESSION_ID).toBe("sess-20260217-abc12345");
  expect(String(env.TMPDIR)).toContain(
    path.join("wt", ".omta", "tmp", "orchestrator", "sess-20260217-abc12345")
  );
});
