import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve(import.meta.dir, "plan_runtime.ts");

function runCli(args: string[]) {
  return spawnSync("bun", [scriptPath, ...args], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: process.env,
  });
}

test("plan_runtime help is intake-only", () => {
  const run = runCli(["--help"]);
  expect(run.status).toBe(0);
  expect(`${run.stdout}`).toContain("intake-upsert");
  expect(`${run.stdout}`).toContain("intake-validate");
  expect(`${run.stdout}`).not.toContain("register-build");
  expect(`${run.stdout}`).not.toContain("register-validate");
});

test("plan_runtime rejects legacy register-build", () => {
  const run = runCli(["register-build"]);
  expect(run.status).toBe(1);
  expect(`${run.stderr}`).toContain(
    "register-build is no longer part of the standard intake surface"
  );
});

test("plan_runtime rejects legacy register-validate", () => {
  const run = runCli(["register-validate"]);
  expect(run.status).toBe(1);
  expect(`${run.stderr}`).toContain(
    "register-validate is no longer part of the standard intake surface"
  );
});
