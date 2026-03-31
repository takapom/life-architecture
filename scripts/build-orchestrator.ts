#!/usr/bin/env bun
/**
 * life-architecture用 orchestrator Rustバイナリビルドスクリプト
 * tools/adapters/rust-runtime.ts と同じハッシュ計算ロジックでターゲットディレクトリを決定する
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function normalizeRepoRelativePath(repoRoot: string, absolutePath: string): string {
  const rel = path.relative(repoRoot, absolutePath);
  return rel.replace(/\\/g, "/");
}

function appendSourceFingerprintEntry(hash: ReturnType<typeof createHash>, repoRoot: string, sourcePath: string): void {
  const label = normalizeRepoRelativePath(repoRoot, sourcePath);
  if (!existsSync(sourcePath)) {
    hash.update("missing\0");
    hash.update(label);
    hash.update("\0");
    return;
  }
  const stats = statSync(sourcePath);
  if (!stats.isDirectory()) {
    hash.update("file\0");
    hash.update(label);
    hash.update("\0");
    hash.update(readFileSync(sourcePath));
    hash.update("\0");
    return;
  }
  hash.update("dir\0");
  hash.update(label);
  hash.update("\0");
  const entries = readdirSync(sourcePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    appendSourceFingerprintEntry(hash, repoRoot, path.join(sourcePath, entry.name));
  }
}

function computeRustToolSourceFingerprint(repoRoot: string, sourcePaths: string[]): string {
  const hash = createHash("sha256");
  const ordered = [...sourcePaths].sort((a, b) =>
    normalizeRepoRelativePath(repoRoot, a).localeCompare(normalizeRepoRelativePath(repoRoot, b))
  );
  for (const sourcePath of ordered) {
    appendSourceFingerprintEntry(hash, repoRoot, sourcePath);
  }
  return hash.digest("hex");
}

// Source paths for orchestrator (same as MANAGED_RUST_TOOL_SPECS.orchestrator)
const sourcePaths = [
  path.join(repoRoot, "Cargo.toml"),
  path.join(repoRoot, "Cargo.lock"),
  path.join(repoRoot, "tools/orchestrator/Cargo.toml"),
  path.join(repoRoot, "tools/orchestrator/src"),
];

const fingerprint = computeRustToolSourceFingerprint(repoRoot, sourcePaths);
const runtimeRoot = path.resolve(path.join(repoRoot, "..", "wt"), ".omta", "rust-runtime");
const targetDir = path.join(runtimeRoot, "targets", "orchestrator", fingerprint);
const binaryPath = path.join(targetDir, "debug", "omta-orchestrator");

console.log(`Source fingerprint: ${fingerprint}`);
console.log(`Target dir: ${targetDir}`);
console.log(`Binary path: ${binaryPath}`);

mkdirSync(targetDir, { recursive: true });

// Build with cargo (without --locked since life-architecture has no workspace Cargo.lock)
const result = spawnSync("cargo", ["build", "--manifest-path", path.join(repoRoot, "tools/orchestrator/Cargo.toml")], {
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  stdio: "inherit",
  cwd: repoRoot,
});

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) {
  console.error("cargo build failed");
  process.exit(result.status ?? 1);
}

// Write provenance file at .build-provenance.json (matches rust-runtime.ts expectation)
const normalizedSourceRoots = [...sourcePaths]
  .map(p => normalizeRepoRelativePath(repoRoot, p))
  .sort((a, b) => a.localeCompare(b));

const provenancePath = path.join(targetDir, ".build-provenance.json");
const provenance = {
  version: 1,
  binarySha256: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"),
  toolId: "orchestrator",
  sourceFingerprint: fingerprint,
  sourceRoots: normalizedSourceRoots,
  writtenAt: new Date().toISOString(),
};
writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + "\n", "utf8");
console.log(`Provenance written to: ${provenancePath}`);
console.log("Build complete.");
