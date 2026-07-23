/**
 * WorkspaceMergeOrchestrator - the ordered-merge + partial-failure policy for a
 * multirepo workspace, isolated from gh/DB so it is directly unit-testable.
 * ws.ts wires the real callbacks (merge via GitWorkflowService, deploy via the
 * project script runner, emit via the RPC stream queue).
 *
 * Policy: walk the member worktrees in ascending deployOrder; skip repos whose
 * PR is already merged or absent (idempotent); on a merge success optionally run
 * the per-repo deploy step; STOP on the first merge OR deploy failure so deploy
 * order is never violated. Every outcome is a stream item (repo_* / completed),
 * never a stream error, so the run is resumable by re-invoking - already-merged
 * repos are skipped and processing resumes at the failed one.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type {
  GitMergeChangeRequestResult,
  WorkspaceMergeProgressEvent,
  WorkspaceWorktree,
} from "@t3tools/contracts";

// mergeRepo and deployRepo have independent error types so ws.ts can wire a
// GitManager merge and a ProjectSetupScriptRunner deploy (different error
// unions) without forcing them together; both are erased by Effect.exit anyway.
export interface WorkspaceMergeCallbacks<EMerge, EDeploy = never> {
  readonly mergeRepo: (
    worktree: WorkspaceWorktree,
  ) => Effect.Effect<GitMergeChangeRequestResult, EMerge>;
  readonly deployRepo?: (worktree: WorkspaceWorktree) => Effect.Effect<void, EDeploy>;
  readonly emit: (event: WorkspaceMergeProgressEvent) => Effect.Effect<void>;
}

export function sortWorktreesByDeployOrder(
  worktrees: ReadonlyArray<WorkspaceWorktree>,
): ReadonlyArray<WorkspaceWorktree> {
  return [...worktrees].sort((a, b) => a.deployOrder - b.deployOrder);
}

function messageOf(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : "Merge failed.";
}

export function runOrderedMerge<EMerge, EDeploy>(
  worktrees: ReadonlyArray<WorkspaceWorktree>,
  callbacks: WorkspaceMergeCallbacks<EMerge, EDeploy>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    let mergedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const worktree of sortWorktreesByDeployOrder(worktrees)) {
      const base = { label: worktree.label, deployOrder: worktree.deployOrder } as const;
      yield* callbacks.emit({ _tag: "repo_started", ...base });

      const mergeExit = yield* Effect.exit(callbacks.mergeRepo(worktree));
      if (Exit.isFailure(mergeExit)) {
        failedCount += 1;
        yield* callbacks.emit({
          _tag: "repo_failed",
          ...base,
          phase: "merge",
          message: messageOf(mergeExit.cause),
        });
        break; // stop-on-first-failure; resumable on re-invoke
      }

      const result = mergeExit.value;
      if (result.status !== "merged") {
        skippedCount += 1;
        yield* callbacks.emit({
          _tag: "repo_skipped",
          ...base,
          reason:
            result.status === "skipped_already_merged" ? "already-merged" : "no-change-request",
        });
        continue;
      }

      mergedCount += 1;
      yield* callbacks.emit({
        _tag: "repo_merged",
        ...base,
        ...(result.prNumber !== undefined ? { prNumber: result.prNumber } : {}),
        ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
      });

      if (callbacks.deployRepo) {
        yield* callbacks.emit({ _tag: "repo_deploying", ...base });
        const deployExit = yield* Effect.exit(callbacks.deployRepo(worktree));
        if (Exit.isFailure(deployExit)) {
          failedCount += 1;
          yield* callbacks.emit({
            _tag: "repo_failed",
            ...base,
            phase: "deploy",
            message: messageOf(deployExit.cause),
          });
          break;
        }
        yield* callbacks.emit({ _tag: "repo_deployed", ...base });
      }
    }

    yield* callbacks.emit({ _tag: "completed", mergedCount, skippedCount, failedCount });
  });
}
