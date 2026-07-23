import * as Encoding from "effect/Encoding";
import {
  CheckpointRef,
  ProjectId,
  type ThreadId,
  type WorkspaceWorktree,
} from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

/**
 * Repo-namespaced checkpoint ref for a thread turn. For a workspace thread each
 * member repo needs its own ref store, so the label (base64url-encoded, so it
 * can't inject `/` or break the ref grammar) is inserted as a `/repo/<label>`
 * segment. With `label` null/absent the ref is byte-identical to the legacy
 * single-repo ref, so single-repo threads are unaffected.
 */
export function checkpointRefForThreadTurnScoped(
  threadId: ThreadId,
  turnCount: number,
  label?: string | null,
): CheckpointRef {
  const base = `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}`;
  const scope = label != null ? `/repo/${Encoding.encodeBase64Url(label)}` : "";
  return CheckpointRef.make(`${base}${scope}/turn/${turnCount}`);
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return checkpointRefForThreadTurnScoped(threadId, turnCount, null);
}

/** A per-repo checkpoint target: single-repo threads yield `[{label:null,cwd}]`;
 *  workspace threads yield one target per member worktree. */
export interface CheckpointRepoTarget {
  readonly label: string | null;
  readonly cwd: string;
}

export function checkpointRepoTargetsFromWorktrees(
  worktrees: ReadonlyArray<WorkspaceWorktree>,
): ReadonlyArray<CheckpointRepoTarget> {
  return worktrees
    .toSorted((left, right) => left.deployOrder - right.deployOrder)
    .map((worktree) => ({ label: worktree.label, cwd: worktree.repoWorktreePath }));
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
