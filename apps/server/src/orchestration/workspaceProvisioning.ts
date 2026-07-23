/**
 * Resilient per-member worktree provisioning for a workspace thread (M6 #2148,
 * #635). Extracted from the ws.ts bootstrap closure so the "one bad repo does
 * not abort the whole fan-out" and "validate label/path before creating a
 * worktree" behaviours are unit-testable with injected git deps.
 *
 * Each member is provisioned in deployOrder. A member is skipped (recorded via
 * onRepoSkipped, then processing continues) when its label/path fails
 * validation, or when any non-interrupt git failure occurs (an empty repo makes
 * `git worktree add -b <branch> <path> HEAD` fatal because HEAD is unborn). A
 * genuine interrupt still aborts, matching the ws.ts bootstrap contract.
 */
import type {
  GitCommandError,
  ThreadTurnStartBootstrapWorkspaceRepo,
  VcsCreateWorktreeResult,
  WorkspaceWorktree,
} from "@t3tools/contracts";
import { validateMemberWorktreePath, type MemberWorktreePathIssue } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export interface WorkspaceProvisionDeps {
  readonly fetchRemote: (input: {
    readonly cwd: string;
    readonly remoteName: string;
  }) => Effect.Effect<void, GitCommandError>;
  readonly resolveRemoteTrackingCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly fallbackRemoteName: string;
  }) => Effect.Effect<
    { readonly commitSha: string; readonly remoteRefName: string },
    GitCommandError
  >;
  readonly createWorktree: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly newRefName: string;
    readonly baseRefName: string;
    readonly path: string;
  }) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly onRepoSkipped: (input: {
    readonly label: string;
    readonly baseBranch: string;
    readonly issue?: MemberWorktreePathIssue;
    readonly cause?: Cause.Cause<unknown>;
  }) => Effect.Effect<void, never>;
}

export function provisionWorkspaceWorktrees(input: {
  readonly workspaceThreadRoot: string;
  readonly branch: string;
  readonly repos: ReadonlyArray<ThreadTurnStartBootstrapWorkspaceRepo>;
  readonly deps: WorkspaceProvisionDeps;
}): Effect.Effect<ReadonlyArray<WorkspaceWorktree>, never> {
  const { deps } = input;
  return Effect.forEach(
    input.repos,
    (repo) => {
      const baseBranch = repo.baseBranch ?? "HEAD";
      return Effect.gen(function* () {
        const validation = validateMemberWorktreePath({
          label: repo.label,
          workspaceThreadRoot: input.workspaceThreadRoot,
        });
        if (!validation.ok) {
          yield* deps.onRepoSkipped({
            label: repo.label,
            baseBranch,
            ...(validation.issue ? { issue: validation.issue } : {}),
          });
          return null;
        }

        let worktreeBaseRef = baseBranch;
        if (repo.startFromOrigin) {
          yield* deps.fetchRemote({ cwd: repo.projectCwd, remoteName: "origin" });
          const resolved = yield* deps.resolveRemoteTrackingCommit({
            cwd: repo.projectCwd,
            refName: baseBranch,
            fallbackRemoteName: "origin",
          });
          worktreeBaseRef = resolved.commitSha;
        }

        const created = yield* deps.createWorktree({
          cwd: repo.projectCwd,
          refName: worktreeBaseRef,
          newRefName: input.branch,
          baseRefName: baseBranch,
          path: `${input.workspaceThreadRoot}/${repo.label}`,
        });
        yield* deps.refreshGitStatus(created.worktree.path);
        return {
          label: repo.label,
          projectId: repo.projectId,
          sourceRepoRoot: repo.projectCwd,
          repoWorktreePath: created.worktree.path,
          branch: input.branch,
          baseBranch,
          deployOrder: repo.deployOrder,
        } satisfies WorkspaceWorktree;
      }).pipe(
        Effect.catchCause((cause) =>
          // A real interrupt (shutdown/disconnect) must still abort bootstrap;
          // any other per-repo failure is recorded and skipped so the rest of
          // the workspace still provisions. An interrupt-only cause carries no
          // failure value, so it is safe to re-raise as Cause<never> - keeping
          // the whole helper's error channel `never`.
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : deps.onRepoSkipped({ label: repo.label, baseBranch, cause }).pipe(Effect.as(null)),
        ),
      );
    },
    { concurrency: 1 },
  ).pipe(
    Effect.map((entries) => entries.filter((entry): entry is WorkspaceWorktree => entry !== null)),
  );
}
