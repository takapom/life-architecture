import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveCanonicalTaskRootFromRepoRoot } from "./worktree";

export type RustToolProfile = "debug" | "release";
export const CANONICAL_RUST_TOOL_BUILD_ALIAS = "bun run dev:tools:rust:build";
export type ManagedRustToolId = "orchestrator" | "repoctl";

export type ManagedRustToolSpec = {
  binaryName: string;
  manifestPath?: string;
  packageName: string;
  profile: RustToolProfile;
  sourceRoots: readonly string[];
  toolId: ManagedRustToolId;
};

const MANAGED_RUST_TOOL_SPECS = {
  orchestrator: {
    binaryName: "omta-orchestrator",
    packageName: "omta-orchestrator",
    profile: "debug",
    sourceRoots: [
      "Cargo.toml",
      "Cargo.lock",
      "tools/orchestrator/Cargo.toml",
      "tools/orchestrator/src",
    ],
    toolId: "orchestrator",
  },
  repoctl: {
    binaryName: "omta-repoctl",
    packageName: "omta-repoctl",
    profile: "debug",
    sourceRoots: ["Cargo.toml", "Cargo.lock", "tools/repoctl/Cargo.toml", "tools/repoctl/src"],
    toolId: "repoctl",
  },
} satisfies Record<ManagedRustToolId, ManagedRustToolSpec>;
const managedRustToolBinaryCache = new Map<string, string>();

function normalizeToolId(toolId: string): string {
  return String(toolId || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRepoRelativePath(repoRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
  if (relativePath && !relativePath.startsWith("../") && relativePath !== "..") {
    return relativePath;
  }
  return path.resolve(absolutePath).split(path.sep).join("/");
}

function normalizeRustToolSourceRoots(repoRoot: string, sourcePaths: readonly string[]): string[] {
  return [...sourcePaths]
    .map((sourcePath) => normalizeRepoRelativePath(repoRoot, sourcePath))
    .sort((left, right) => left.localeCompare(right));
}

export function computeFileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function appendSourceFingerprintEntry(
  hash: ReturnType<typeof createHash>,
  repoRoot: string,
  sourcePath: string
): void {
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
  const entries = readdirSync(sourcePath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    appendSourceFingerprintEntry(hash, repoRoot, path.join(sourcePath, entry.name));
  }
}

export function computeRustToolSourceFingerprint(
  repoRoot: string,
  sourcePaths: readonly string[]
): string {
  const hash = createHash("sha256");
  const orderedSourcePaths = [...sourcePaths].sort((left, right) =>
    normalizeRepoRelativePath(repoRoot, left).localeCompare(
      normalizeRepoRelativePath(repoRoot, right)
    )
  );
  for (const sourcePath of orderedSourcePaths) {
    appendSourceFingerprintEntry(hash, repoRoot, sourcePath);
  }
  return hash.digest("hex");
}

export type RustToolBuildProvenance = {
  version: 1;
  binarySha256: string;
  toolId: ManagedRustToolId;
  sourceFingerprint: string;
  sourceRoots: string[];
  writtenAt: string;
};

const RUST_TOOL_BUILD_PROVENANCE_VERSION = 1;

function isRustToolBuildProvenance(value: unknown): value is RustToolBuildProvenance {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RustToolBuildProvenance>;
  return (
    candidate.version === RUST_TOOL_BUILD_PROVENANCE_VERSION &&
    typeof candidate.binarySha256 === "string" &&
    typeof candidate.toolId === "string" &&
    typeof candidate.sourceFingerprint === "string" &&
    Array.isArray(candidate.sourceRoots) &&
    candidate.sourceRoots.every((entry) => typeof entry === "string") &&
    typeof candidate.writtenAt === "string"
  );
}

function isManagedRustToolId(toolId: string): toolId is ManagedRustToolId {
  return Object.hasOwn(MANAGED_RUST_TOOL_SPECS, toolId);
}

function parseIsoTimestamp(value: unknown): number {
  const text = String(value || "").trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listManagedRustToolSpecs(): readonly ManagedRustToolSpec[] {
  return Object.values(MANAGED_RUST_TOOL_SPECS);
}

export function resolveManagedRustToolSpec(toolId: ManagedRustToolId): ManagedRustToolSpec {
  return MANAGED_RUST_TOOL_SPECS[toolId];
}

export function resolveManagedRustToolProfile(toolId: ManagedRustToolId): RustToolProfile {
  return resolveManagedRustToolSpec(toolId).profile;
}

export function resolveRustRuntimeRootFromRepoRoot(repoRoot: string): string {
  return path.join(resolveCanonicalTaskRootFromRepoRoot(repoRoot), ".omta", "rust-runtime");
}

function resolveGitDirFromRepoRoot(repoRoot: string): string {
  const gitEntryPath = path.join(repoRoot, ".git");
  if (!existsSync(gitEntryPath)) {
    throw new Error(`failed to resolve git dir: missing ${gitEntryPath}`);
  }
  const stats = statSync(gitEntryPath);
  if (stats.isDirectory()) {
    return gitEntryPath;
  }
  const raw = readFileSync(gitEntryPath, "utf8");
  const match = raw.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match?.[1]) {
    throw new Error(`failed to resolve git dir from ${gitEntryPath}`);
  }
  return path.resolve(repoRoot, match[1]);
}

export function resolveGitCommonDirFromRepoRoot(repoRoot: string): string {
  const gitDir = resolveGitDirFromRepoRoot(repoRoot);
  const commondirPath = path.join(gitDir, "commondir");
  if (!existsSync(commondirPath)) {
    return gitDir;
  }
  const commondir = readFileSync(commondirPath, "utf8").trim();
  if (!commondir) {
    return gitDir;
  }
  return path.resolve(gitDir, commondir);
}

export function resolveRepoctlRuntimeStateRoot(repoRoot: string): string {
  return path.join(resolveGitCommonDirFromRepoRoot(repoRoot), "repoctl");
}

export function ensureRepoctlRuntimeStateRoot(repoRoot: string): string {
  const stateRoot = resolveRepoctlRuntimeStateRoot(repoRoot);
  mkdirSync(stateRoot, { recursive: true });
  return stateRoot;
}

export function resolveRepoctlDaemonSocketPath(repoRoot: string): string {
  return path.join(resolveGitCommonDirFromRepoRoot(repoRoot), "r.sock");
}

export function resolveRepoctlStateStorePath(repoRoot: string): string {
  return path.join(resolveRepoctlRuntimeStateRoot(repoRoot), "state.sqlite");
}

export function resolveManagedRustToolSourceFingerprint(
  repoRoot: string,
  toolId: ManagedRustToolId,
  sourcePaths?: readonly string[]
): string {
  return computeRustToolSourceFingerprint(
    repoRoot,
    sourcePaths || resolveManagedRustToolSourceRoots(repoRoot, toolId)
  );
}

export function resolveManagedRustToolTargetDir(options: {
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  toolId: ManagedRustToolId;
}): string {
  const runtimeRoot = options.runtimeRoot || resolveRustRuntimeRootFromRepoRoot(options.repoRoot);
  const normalizedToolId = normalizeToolId(options.toolId);
  if (!normalizedToolId) {
    throw new Error("rust runtime toolId must not be empty");
  }
  return path.join(
    runtimeRoot,
    "targets",
    normalizedToolId,
    resolveManagedRustToolSourceFingerprint(options.repoRoot, options.toolId, options.sourcePaths)
  );
}

function isCanonicalManagedRustRuntimeRoot(repoRoot: string, runtimeRoot?: string): boolean {
  const candidateRuntimeRoot = String(runtimeRoot || "").trim();
  if (!candidateRuntimeRoot) {
    return false;
  }
  try {
    return (
      path.resolve(candidateRuntimeRoot) ===
      path.resolve(resolveRustRuntimeRootFromRepoRoot(repoRoot))
    );
  } catch {
    return false;
  }
}

export function resolveRustToolTargetDir(options: {
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  toolId: string;
}): string {
  const runtimeRoot = options.runtimeRoot || resolveRustRuntimeRootFromRepoRoot(options.repoRoot);
  const normalizedToolId = normalizeToolId(options.toolId);
  if (!normalizedToolId) {
    throw new Error("rust runtime toolId must not be empty");
  }
  const useContentAddressedManagedTargetDir =
    isManagedRustToolId(normalizedToolId) &&
    (!options.runtimeRoot ||
      isCanonicalManagedRustRuntimeRoot(options.repoRoot, options.runtimeRoot));
  // Non-canonical runtimeRoot/targetDir overrides are deliberate escape hatches; the canonical
  // shared runtime path remains content-addressed by source fingerprint even when passed explicitly.
  if (useContentAddressedManagedTargetDir) {
    return resolveManagedRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: normalizedToolId,
    });
  }
  return path.join(runtimeRoot, "targets", normalizedToolId);
}

export function resolveRustToolBuildLockPath(options: {
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: string;
}): string {
  const targetDir =
    options.targetDir ||
    resolveRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: options.toolId,
    });
  return path.join(targetDir, ".build.lock");
}

export function resolveRustToolBuildProvenancePath(options: {
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: string;
}): string {
  const targetDir =
    options.targetDir ||
    resolveRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: options.toolId,
    });
  return path.join(targetDir, ".build-provenance.json");
}

export function resolveRustToolBinaryPath(options: {
  binaryName: string;
  profile: RustToolProfile;
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: string;
}): string {
  const targetDir =
    options.targetDir ||
    resolveRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: options.toolId,
    });
  const binaryName =
    process.platform === "win32" ? `${options.binaryName}.exe` : options.binaryName;
  return path.join(targetDir, options.profile, binaryName);
}

export function resolveManagedRustToolBinaryPath(options: {
  profile?: RustToolProfile;
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: ManagedRustToolId;
}): string {
  const spec = resolveManagedRustToolSpec(options.toolId);
  return resolveRustToolBinaryPath({
    binaryName: spec.binaryName,
    profile: options.profile ?? spec.profile,
    repoRoot: options.repoRoot,
    runtimeRoot: options.runtimeRoot,
    sourcePaths: options.sourcePaths,
    targetDir: options.targetDir,
    toolId: options.toolId,
  });
}

export function resolveManagedRustToolSourceRoots(
  repoRoot: string,
  toolId: ManagedRustToolId
): string[] {
  const spec = resolveManagedRustToolSpec(toolId);
  return spec.sourceRoots.map((relativePath) => path.join(repoRoot, relativePath));
}

export function readRustToolBuildProvenance(
  provenancePath: string
): RustToolBuildProvenance | null {
  if (!existsSync(provenancePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(provenancePath, "utf8")) as unknown;
    return isRustToolBuildProvenance(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeManagedRustToolBuildProvenance(options: {
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: ManagedRustToolId;
}): RustToolBuildProvenance {
  const targetDir =
    options.targetDir ||
    resolveRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: options.toolId,
    });
  const sourcePaths =
    options.sourcePaths || resolveManagedRustToolSourceRoots(options.repoRoot, options.toolId);
  const binaryPath = resolveManagedRustToolBinaryPath({
    repoRoot: options.repoRoot,
    runtimeRoot: options.runtimeRoot,
    targetDir,
    toolId: options.toolId,
  });
  if (!existsSync(binaryPath)) {
    throw new Error(
      `cannot write managed Rust tool provenance without a built binary: missing ${binaryPath}`
    );
  }
  const provenance: RustToolBuildProvenance = {
    version: RUST_TOOL_BUILD_PROVENANCE_VERSION,
    binarySha256: computeFileSha256(binaryPath),
    toolId: options.toolId,
    sourceFingerprint: computeRustToolSourceFingerprint(options.repoRoot, sourcePaths),
    sourceRoots: normalizeRustToolSourceRoots(options.repoRoot, sourcePaths),
    writtenAt: new Date().toISOString(),
  };
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    resolveRustToolBuildProvenancePath({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      targetDir,
      toolId: options.toolId,
    }),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8"
  );
  return provenance;
}

export function isRustToolBinaryFresh(options: {
  binaryPath: string;
  provenancePath?: string;
  repoRoot: string;
  sourcePaths: readonly string[];
  targetDir?: string;
  toolId: ManagedRustToolId;
}): boolean {
  if (!existsSync(options.binaryPath)) {
    return false;
  }
  const provenancePath =
    options.provenancePath ||
    resolveRustToolBuildProvenancePath({
      repoRoot: options.repoRoot,
      targetDir: options.targetDir || path.resolve(path.dirname(options.binaryPath), ".."),
      toolId: options.toolId,
    });
  const provenance = readRustToolBuildProvenance(provenancePath);
  if (!provenance || provenance.toolId !== options.toolId) {
    return false;
  }
  const normalizedSourceRoots = normalizeRustToolSourceRoots(options.repoRoot, options.sourcePaths);
  if (
    provenance.sourceRoots.length !== normalizedSourceRoots.length ||
    provenance.sourceRoots.some((entry, index) => entry !== normalizedSourceRoots[index])
  ) {
    return false;
  }
  return (
    provenance.sourceFingerprint ===
      computeRustToolSourceFingerprint(options.repoRoot, options.sourcePaths) &&
    provenance.binarySha256 === computeFileSha256(options.binaryPath)
  );
}

export function buildManagedRustToolCargoArgs(toolId: ManagedRustToolId): string[] {
  const spec = resolveManagedRustToolSpec(toolId);
  return [
    "build",
    "--locked",
    ...(spec.profile === "release" ? ["--release"] : []),
    ...(spec.manifestPath ? ["--manifest-path", spec.manifestPath] : ["-p", spec.packageName]),
  ];
}

export function buildCargoBuildCommand(options: {
  args: string[];
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: string;
}): string {
  const targetDir =
    options.targetDir ||
    resolveRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: options.toolId,
    });
  return `CARGO_TARGET_DIR=${targetDir} cargo ${options.args.join(" ")}`;
}

export function buildManagedRustToolBuildCommand(options: {
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: ManagedRustToolId;
}): string {
  return buildCargoBuildCommand({
    args: buildManagedRustToolCargoArgs(options.toolId),
    repoRoot: options.repoRoot,
    runtimeRoot: options.runtimeRoot,
    sourcePaths: options.sourcePaths,
    targetDir: options.targetDir,
    toolId: options.toolId,
  });
}

export type RustToolBuildLockStatus = "absent" | "legacy" | "active" | "stale";

export type RustToolBuildLockState = {
  detail: string;
  path: string;
  status: RustToolBuildLockStatus;
};

export function readRustToolBuildLockState(
  lockPath: string,
  nowMs = Date.now()
): RustToolBuildLockState {
  if (!existsSync(lockPath)) {
    return {
      path: lockPath,
      status: "absent",
      detail: "absent",
    };
  }

  const raw = readFileSync(lockPath, "utf8").trim();
  if (!raw) {
    return {
      path: lockPath,
      status: "legacy",
      detail: "legacy sentinel lock",
    };
  }

  try {
    const parsed = JSON.parse(raw) as {
      hostname?: unknown;
      leaseExpiresAt?: unknown;
      pid?: unknown;
      startedAt?: unknown;
    };
    const pid = Number(parsed.pid || 0);
    const leaseExpiresAtMs = parseIsoTimestamp(parsed.leaseExpiresAt);
    const startedAtMs = parseIsoTimestamp(parsed.startedAt);
    const active = processIsAlive(pid) && leaseExpiresAtMs > nowMs;
    const status: RustToolBuildLockStatus = active ? "active" : "stale";
    const startedAt = startedAtMs > 0 ? new Date(startedAtMs).toISOString() : "unknown";
    const leaseExpiresAt =
      leaseExpiresAtMs > 0 ? new Date(leaseExpiresAtMs).toISOString() : "unknown";
    const hostname = String(parsed.hostname || "").trim() || "unknown";
    return {
      path: lockPath,
      status,
      detail: `json lease pid=${pid || "unknown"} host=${hostname} started_at=${startedAt} lease_expires_at=${leaseExpiresAt}`,
    };
  } catch {
    return {
      path: lockPath,
      status: "legacy",
      detail: "legacy non-JSON sentinel lock",
    };
  }
}

export type ManagedRustToolRuntimeReadiness = {
  buildLockPath: string;
  buildLockState: RustToolBuildLockState;
  reason: "missing_binary" | "stale_binary";
  binaryPath: string;
  buildCommand: string;
  repoRoot: string;
  targetDir: string;
  toolId: ManagedRustToolId;
};

export function resolveManagedRustToolRuntimeReadiness(options: {
  binaryPath?: string;
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: ManagedRustToolId;
}): ManagedRustToolRuntimeReadiness | null {
  const targetDir =
    options.targetDir ||
    resolveRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: options.toolId,
    });
  const binaryPath =
    options.binaryPath ||
    resolveManagedRustToolBinaryPath({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      targetDir,
      toolId: options.toolId,
    });
  const buildLockPath = resolveRustToolBuildLockPath({
    repoRoot: options.repoRoot,
    runtimeRoot: options.runtimeRoot,
    targetDir,
    toolId: options.toolId,
  });
  const buildLockState = readRustToolBuildLockState(buildLockPath);
  const sourcePaths =
    options.sourcePaths || resolveManagedRustToolSourceRoots(options.repoRoot, options.toolId);
  if (!existsSync(binaryPath)) {
    return {
      buildLockPath,
      buildLockState,
      reason: "missing_binary",
      binaryPath,
      buildCommand: buildManagedRustToolBuildCommand({
        repoRoot: options.repoRoot,
        runtimeRoot: options.runtimeRoot,
        sourcePaths,
        targetDir,
        toolId: options.toolId,
      }),
      repoRoot: options.repoRoot,
      targetDir,
      toolId: options.toolId,
    };
  }
  if (
    !isRustToolBinaryFresh({
      binaryPath,
      repoRoot: options.repoRoot,
      sourcePaths,
      targetDir,
      toolId: options.toolId,
    })
  ) {
    return {
      buildLockPath,
      buildLockState,
      reason: "stale_binary",
      binaryPath,
      buildCommand: buildManagedRustToolBuildCommand({
        repoRoot: options.repoRoot,
        runtimeRoot: options.runtimeRoot,
        sourcePaths,
        targetDir,
        toolId: options.toolId,
      }),
      repoRoot: options.repoRoot,
      targetDir,
      toolId: options.toolId,
    };
  }
  return null;
}

export function formatManagedRustToolRuntimeReadinessError(
  readiness: ManagedRustToolRuntimeReadiness
): string {
  if (!isManagedRustToolId(readiness.toolId)) {
    throw new Error(`unknown managed Rust toolId: ${readiness.toolId}`);
  }
  const reasonLabel =
    readiness.reason === "missing_binary"
      ? `${readiness.toolId} binary is missing`
      : `${readiness.toolId} binary is stale`;
  const lockHint =
    readiness.buildLockState.status === "absent"
      ? ""
      : ` build_lock_${readiness.buildLockState.status}=${readiness.buildLockPath} (${readiness.buildLockState.detail})`;
  return (
    `${readiness.toolId} runtime is not ready: ${reasonLabel} (${readiness.binaryPath}). ` +
    `${lockHint ? `${lockHint} ` : ""}build the canonical Rust tool binaries explicitly with '${CANONICAL_RUST_TOOL_BUILD_ALIAS}' from ${readiness.repoRoot}. ` +
    `The runtime fails closed on stale or missing binaries and does not compile ${readiness.toolId} implicitly.`
  );
}

export function ensureManagedRustToolBinary(options: {
  binaryPath?: string;
  repoRoot: string;
  runtimeRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
  toolId: ManagedRustToolId;
}): string {
  const targetDir =
    options.targetDir ||
    resolveRustToolTargetDir({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      toolId: options.toolId,
    });
  const binaryPath =
    options.binaryPath ||
    resolveManagedRustToolBinaryPath({
      repoRoot: options.repoRoot,
      runtimeRoot: options.runtimeRoot,
      sourcePaths: options.sourcePaths,
      targetDir,
      toolId: options.toolId,
    });
  const sourcePaths =
    options.sourcePaths || resolveManagedRustToolSourceRoots(options.repoRoot, options.toolId);
  const cacheKey = `${options.repoRoot}:${options.toolId}:${binaryPath}`;
  const cached = managedRustToolBinaryCache.get(cacheKey);
  if (
    cached &&
    cached === binaryPath &&
    isRustToolBinaryFresh({
      binaryPath,
      repoRoot: options.repoRoot,
      sourcePaths,
      targetDir,
      toolId: options.toolId,
    })
  ) {
    return cached;
  }
  const readiness = resolveManagedRustToolRuntimeReadiness({
    binaryPath,
    repoRoot: options.repoRoot,
    runtimeRoot: options.runtimeRoot,
    sourcePaths,
    targetDir,
    toolId: options.toolId,
  });
  if (!readiness) {
    managedRustToolBinaryCache.set(cacheKey, binaryPath);
    return binaryPath;
  }
  throw new Error(formatManagedRustToolRuntimeReadinessError(readiness));
}
