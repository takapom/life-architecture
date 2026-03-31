export function normalizeTaskScopeVerificationCommand(command: string): string {
  const extractFileScopedUnitTestFiles = (
    candidate: string,
    packageName: "@omta/api" | "@omta/worker"
  ): string | null => {
    const prefixes = [
      `bun run --filter ${packageName} test:unit:file -- `,
      `bun run --filter '${packageName}' test:unit:file -- `,
      `bun run --filter ${packageName} test:unit:file `,
      `bun run --filter '${packageName}' test:unit:file `,
    ];

    for (const prefix of prefixes) {
      if (candidate.startsWith(prefix)) {
        return candidate.slice(prefix.length);
      }
    }

    return null;
  };

  if (command === "bun run --filter @omta/api test:unit:local-smoke") {
    return "OMTA_TEST_DATABASE_URL='postgresql://omta-test-contract.invalid/apps-api' bun run --filter @omta/api test:unit:local-smoke";
  }
  if (command === "bun run --filter @omta/worker test:unit:local-smoke") {
    return "OMTA_TEST_DATABASE_URL='postgresql://omta-test-contract.invalid/apps-worker' bun run --filter @omta/worker test:unit:local-smoke";
  }
  const apiFiles = extractFileScopedUnitTestFiles(command, "@omta/api");
  if (apiFiles !== null) {
    const files = apiFiles;
    return `OMTA_TEST_DATABASE_URL='postgresql://omta-test-contract.invalid/apps-api' bun run --cwd 'apps/api' test:unit:file -- ${files}`;
  }
  const workerFiles = extractFileScopedUnitTestFiles(command, "@omta/worker");
  if (workerFiles !== null) {
    const files = workerFiles;
    return `OMTA_TEST_DATABASE_URL='postgresql://omta-test-contract.invalid/apps-worker' bun run --cwd 'apps/worker' test:unit:file -- ${files}`;
  }
  return command;
}

export function normalizeTaskScopeVerificationCommands(commands: string[]): string[] {
  return commands.map((command) => normalizeTaskScopeVerificationCommand(command));
}
