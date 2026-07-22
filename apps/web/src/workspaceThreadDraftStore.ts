import type { ProjectId, ThreadId, WorkspaceId } from "@t3tools/contracts";

/**
 * Transient, in-memory workspace context for a not-yet-sent workspace-thread
 * draft, keyed by the draft's threadId. It is only needed at the moment of the
 * first send (to build the `prepareWorkspaceWorktrees` bootstrap), so it is kept
 * out of the persisted draft store to avoid churning the core chat/draft schema.
 * If the tab is reloaded before the first message is sent, the draft degrades to
 * a normal single-repo thread on its primary project - an acceptable tradeoff.
 */
export interface WorkspaceThreadDraftRepo {
  readonly projectId: ProjectId;
  readonly label: string;
  readonly projectCwd: string;
  readonly baseBranch: string | null;
  readonly deployOrder: number;
}

export interface WorkspaceThreadDraftContext {
  readonly workspaceId: WorkspaceId;
  readonly repos: ReadonlyArray<WorkspaceThreadDraftRepo>;
}

const contextByThreadId = new Map<string, WorkspaceThreadDraftContext>();

export function setWorkspaceThreadDraftContext(
  threadId: ThreadId,
  context: WorkspaceThreadDraftContext,
): void {
  contextByThreadId.set(threadId, context);
}

export function getWorkspaceThreadDraftContext(
  threadId: ThreadId,
): WorkspaceThreadDraftContext | null {
  return contextByThreadId.get(threadId) ?? null;
}

export function clearWorkspaceThreadDraftContext(threadId: ThreadId): void {
  contextByThreadId.delete(threadId);
}
