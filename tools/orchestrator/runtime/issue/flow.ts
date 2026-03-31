import {
  assertIssueReferenceRepository,
  getFlag,
  hasBoolFlag,
  resolveParentIssueReferenceFlag,
  resolveRequiredRepository,
  resolveSingleIssueNumberFlag,
} from "./cli";
import {
  fail,
  nowIsoUtc,
  readJsonFromInput,
  uniqueStrings,
  usage,
  writeJsonOutput,
} from "./common";
import type { ParsedCli, UpsertTargetIssue } from "./contracts";
import {
  applyParentIssueReferenceForCommand,
  applySingleIssueNumber,
  assertParentIssueContract,
  parseUpsertItemsForCommand,
} from "./payload";
import { createIssue, resolveTargetIssue, updateIssue } from "./repository";
import { ensureSubIssueLink, planSubIssueLinkState, syncIssueLabels } from "./sync";

export async function runIssueCli(argv: string[]): Promise<void> {
  await Promise.resolve();
  const { command, flags } = argv as unknown as ParsedCli;
  const outputPath = getFlag(flags, "output");

  if (command === "upsert-task-issues") {
    const repository = resolveRequiredRepository(flags);
    const inputPath = getFlag(flags, "input");
    const rawPayload = readJsonFromInput(inputPath);
    const parsedItems = parseUpsertItemsForCommand(rawPayload, command);
    const issueNumber = resolveSingleIssueNumberFlag(flags);
    const parentIssueRef = resolveParentIssueReferenceFlag(flags);
    assertParentIssueContract(parsedItems, parentIssueRef);
    if (parentIssueRef?.repository) {
      assertIssueReferenceRepository(repository, parentIssueRef.repository, "parent-issue");
    }
    const items = applyParentIssueReferenceForCommand(
      applySingleIssueNumber(parsedItems, issueNumber),
      parentIssueRef?.issueNumber
    );
    const dryRun = hasBoolFlag(flags, "dry-run");
    const createOnly = hasBoolFlag(flags, "create-only");

    const ordered = [...items].sort((left, right) => {
      const byTask = left.taskIdHint.localeCompare(right.taskIdHint);
      if (byTask !== 0) return byTask;
      return left.issue.title.localeCompare(right.issue.title);
    });
    const results = [];
    const resolvedByTaskId = new Map<string, UpsertTargetIssue>();

    for (const item of ordered) {
      const payload = {
        ...item.issue,
        labels: uniqueStrings(item.issue.labels),
      };

      let target = resolvedByTaskId.get(item.taskIdHint) || null;
      if (!target) {
        target = resolveTargetIssue(repository, item);
      } else if (item.issueNumber > 0 && item.issueNumber !== target.number) {
        fail(
          [
            `task_id ${item.taskIdHint} is referenced by multiple issue numbers in a single upsert payload`,
            `cached=#${target.number}`,
            `requested=#${item.issueNumber}`,
          ].join(" | ")
        );
      }

      if (createOnly && target) {
        fail(
          `task_id ${item.taskIdHint} already exists as #${target.number}; create-only mode refuses updates`
        );
      }

      if (dryRun) {
        let subIssueLinkState = "not_requested";
        if (item.parentIssueNumber > 0) {
          if (target?.number && target.number > 0) {
            subIssueLinkState = planSubIssueLinkState(
              repository,
              item.parentIssueNumber,
              target.number
            );
          } else {
            subIssueLinkState = "link_planned";
          }
        }
        results.push({
          action: target ? "update_planned" : "create_planned",
          repository,
          task_id: item.taskIdHint,
          issue_number: target?.number || 0,
          issue_url: target?.url || "",
          title: payload.title,
          parent_issue_number: item.parentIssueNumber > 0 ? item.parentIssueNumber : undefined,
          sub_issue_link_state: subIssueLinkState,
        });
        continue;
      }

      let resolved: UpsertTargetIssue;
      let action: "created" | "updated";
      if (target) {
        resolved = updateIssue(repository, target.number, payload);
        action = "updated";
      } else {
        resolved = createIssue(repository, payload);
        action = "created";
      }

      syncIssueLabels(repository, resolved.number, payload.labels);
      const subIssueLinkState = ensureSubIssueLink(
        repository,
        item.parentIssueNumber,
        resolved.number
      );

      resolvedByTaskId.set(item.taskIdHint, resolved);
      results.push({
        action,
        repository,
        task_id: item.taskIdHint,
        issue_number: resolved.number,
        issue_url: resolved.url,
        title: payload.title,
        parent_issue_number: item.parentIssueNumber > 0 ? item.parentIssueNumber : undefined,
        sub_issue_link_state: subIssueLinkState,
      });
    }

    writeJsonOutput(
      {
        generated_at: nowIsoUtc(),
        repository,
        dry_run: dryRun,
        create_only: createOnly,
        count: results.length,
        results,
      },
      outputPath
    );
    return;
  }

  fail(`unknown command: ${command}\n\n${usage()}`);
}
