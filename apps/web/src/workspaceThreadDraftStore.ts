import type { ProjectId, ThreadId, WorkspaceId } from "@t3tools/contracts";

/**
 * Workspace context for a not-yet-sent workspace-thread draft, keyed by the
 * draft's threadId. It is needed at the moment of the first send (to build the
 * `prepareWorkspaceWorktrees` bootstrap) and must survive a page reload / HMR
 * between clicking "new workspace thread" and sending - so it is persisted to
 * localStorage rather than kept in a module-level map. It is cleared once the
 * thread is sent (after which thread.worktrees is the source of truth).
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

const STORAGE_KEY = "t3code:workspace-thread-draft-context";

function readAll(): Record<string, WorkspaceThreadDraftContext> {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, WorkspaceThreadDraftContext>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, WorkspaceThreadDraftContext>): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort persistence; ignore quota/serialization failures.
  }
}

export function setWorkspaceThreadDraftContext(
  threadId: ThreadId,
  context: WorkspaceThreadDraftContext,
): void {
  const all = readAll();
  all[threadId] = context;
  writeAll(all);
}

export function getWorkspaceThreadDraftContext(
  threadId: ThreadId,
): WorkspaceThreadDraftContext | null {
  return readAll()[threadId] ?? null;
}

export function clearWorkspaceThreadDraftContext(threadId: ThreadId): void {
  const all = readAll();
  if (threadId in all) {
    delete all[threadId];
    writeAll(all);
  }
}
