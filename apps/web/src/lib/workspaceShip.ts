import type {
  GitRunStackedActionResult,
  VcsStatusResult,
  WorkspaceWorktree,
} from "@t3tools/contracts";

/**
 * Pure, hook-free logic for the workspace "Ship all repos" flow, kept out of the
 * component so it can be unit-tested without React/atoms. The component drives
 * the existing per-cwd vcsAction machinery imperatively; these helpers own the
 * shared-branch resolution, the no-change filter, and the per-repo result
 * aggregation.
 */

/**
 * Every member worktree of a workspace thread is created on the SAME branch
 * (the server bootstrap sets each provisioned worktree's branch to the shared
 * `prepare.branch`). Return that shared branch, or null when the thread has no
 * worktrees. Used as a guard - a workspace thread without a shared branch has
 * nothing to ship.
 */
export function resolveWorkspaceShipBranch(
  worktrees: ReadonlyArray<WorkspaceWorktree>,
): string | null {
  return worktrees[0]?.branch ?? null;
}

/**
 * A repo is worth shipping only if it has uncommitted work or unpushed commits.
 * Mirrors PRD 13.1: filter worktrees whose status shows working-tree changes or
 * `aheadCount > 0` so clean repos never open an empty pull request.
 */
export function isWorktreeShippable(status: VcsStatusResult): boolean {
  return status.hasWorkingTreeChanges || status.aheadCount > 0;
}

/**
 * Extract the pull-request URL from a stacked-action result. The canonical
 * source is the toast's `open_pr` CTA (present for both freshly created and
 * pre-existing PRs); fall back to the raw `pr.url`. Returns null when the action
 * opened no PR (e.g. a no-change repo).
 */
export function resolveShipPrUrl(result: GitRunStackedActionResult): string | null {
  if (result.toast.cta.kind === "open_pr") {
    return result.toast.cta.url;
  }
  if ((result.pr.status === "created" || result.pr.status === "opened_existing") && result.pr.url) {
    return result.pr.url;
  }
  return null;
}

export interface WorkspaceShipEntry {
  readonly label: string;
  readonly prUrl: string | null;
  readonly error: string | null;
}

export interface WorkspaceShipSummary {
  readonly shipped: number;
  readonly failed: number;
  readonly openPrs: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  readonly failures: ReadonlyArray<{ readonly label: string; readonly message: string }>;
}

/**
 * Fold the per-repo ship outcomes into counts + the lists needed for the
 * summary toast. A repo counts as shipped unless it recorded an error.
 */
export function summarizeWorkspaceShip(
  entries: ReadonlyArray<WorkspaceShipEntry>,
): WorkspaceShipSummary {
  const openPrs: { label: string; url: string }[] = [];
  const failures: { label: string; message: string }[] = [];
  for (const entry of entries) {
    if (entry.error !== null) {
      failures.push({ label: entry.label, message: entry.error });
    } else if (entry.prUrl !== null) {
      openPrs.push({ label: entry.label, url: entry.prUrl });
    }
  }
  return {
    shipped: entries.length - failures.length,
    failed: failures.length,
    openPrs,
    failures,
  };
}
