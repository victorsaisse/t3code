import type {
  EnvironmentThreadShell,
  EnvironmentWorkspace,
} from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MAX_MEMBER_LABEL_LENGTH } from "@t3tools/shared/path";
import type { EnvironmentId, ThreadId, WorkspaceId, WorkspaceMember } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  BoxesIcon,
  ChevronRightIcon,
  LoaderIcon,
  PlusIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useWorkspaceThreadHandler } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "../localApi";
import { newWorkspaceId } from "../lib/utils";
import { useProjects, useThreadShells, useWorkspaces } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";
import { workspaceEnvironment } from "../state/workspaces";
import { buildThreadRouteParams } from "../threadRoutes";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground";

// Derive a short, filesystem-safe subfolder label from a project title, keeping
// it unique within the picked set. Labels become worktree subfolder names in M2.
function deriveMemberLabel(title: string, index: number, taken: ReadonlySet<string>): string {
  const base =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_MEMBER_LABEL_LENGTH) || `repo-${index + 1}`;
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

const AddWorkspaceDialog = memo(function AddWorkspaceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { open, onOpenChange } = props;
  const projects = useProjects();
  const createWorkspace = useAtomCommand(workspaceEnvironment.create, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectKey = useCallback(
    (project: (typeof projects)[number]) => `${project.environmentId}:${project.id}`,
    [],
  );

  const toggle = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setTitle("");
    setSelectedKeys(new Set());
    setError(null);
    setSubmitting(false);
  }, []);

  const selectedProjects = useMemo(
    () => projects.filter((project) => selectedKeys.has(projectKey(project))),
    [projectKey, projects, selectedKeys],
  );

  const canSubmit = title.trim().length > 0 && selectedProjects.length > 0 && !submitting;

  const handleCreate = useCallback(async () => {
    if (selectedProjects.length === 0 || title.trim().length === 0) {
      return;
    }
    // A workspace is dispatched to a single environment; members reference
    // projects by id. Use the environment of the first picked project.
    const environmentId = selectedProjects[0]!.environmentId;
    const taken = new Set<string>();
    const members: WorkspaceMember[] = selectedProjects.map((project, index) => {
      const label = deriveMemberLabel(project.title, index, taken);
      taken.add(label);
      return { projectId: project.id, label, baseBranch: null, deployOrder: index };
    });

    setSubmitting(true);
    setError(null);
    const result = await createWorkspace({
      environmentId,
      input: {
        workspaceId: newWorkspaceId(),
        title: title.trim(),
        members,
        defaultModelSelection: null,
      },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError("Failed to create workspace. Please try again.");
      }
      return;
    }
    reset();
    onOpenChange(false);
  }, [createWorkspace, onOpenChange, reset, selectedProjects, title]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          reset();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            A workspace is a named set of repositories you can drive from one thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5 pt-2 pb-2">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="workspace-name">
              Name
            </label>
            <Input
              id="workspace-name"
              autoFocus
              placeholder="Frontend"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Member repositories</span>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                Add projects first, then group them into a workspace.
              </p>
            ) : (
              <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border/60 p-1.5">
                {projects.map((project) => {
                  const key = projectKey(project);
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-accent"
                    >
                      <Checkbox
                        checked={selectedKeys.has(key)}
                        onCheckedChange={() => toggle(key)}
                      />
                      <span className="truncate">{project.title}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            }
          />
          <Button type="button" disabled={!canSubmit} onClick={handleCreate}>
            {submitting ? <LoaderIcon className="size-4 animate-spin" /> : null}
            Create workspace
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});

const SidebarWorkspaceRow = memo(function SidebarWorkspaceRow(props: {
  workspace: EnvironmentWorkspace;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  activeThreadKey: string | null;
  expanded: boolean;
  onToggleExpanded: (workspaceId: WorkspaceId) => void;
  onNavigateThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { workspace, threads, activeThreadKey, expanded, onToggleExpanded, onNavigateThread } =
    props;
  const deleteWorkspace = useAtomCommand(workspaceEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const startWorkspaceThread = useWorkspaceThreadHandler();
  const memberCount = workspace.members.length;
  const memberSummary = workspace.members.map((member) => member.label).join(" · ");

  // Manual rename for workspace threads, mirroring the project-thread rename in
  // SidebarV2 (double-click or right-click -> Rename). The RPC (thread.meta.update)
  // is thread-id-keyed, so no server change is needed.
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (renamingThreadId !== null) renameCommittedRef.current = false;
  }, [renamingThreadId]);

  // Full thread context menu (matches project threads): mark unread, copy path,
  // copy id, delete. deleteThread from useThreadActions handles workspace-thread
  // worktree cleanup (N member worktrees + shared root).
  const { deleteThread, archiveThread } = useThreadActions();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) =>
      toastManager.add({ type: "success", title: "Thread ID copied", description: ctx.threadId }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) =>
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });

  const startRename = useCallback((thread: EnvironmentThreadShell) => {
    setRenamingThreadId(thread.id);
    setRenamingTitle(thread.title);
  }, []);

  const commitRename = useCallback(
    (thread: EnvironmentThreadShell, nextTitle: string) => {
      void (async () => {
        const trimmed = nextTitle.trim();
        setRenamingThreadId(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === thread.title) return;
        const result = await updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, title: trimmed },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );

  const openThreadContextMenu = useCallback(
    (thread: EnvironmentThreadShell, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const threadKey = scopedThreadKey(threadRef);
      void (async () => {
        const choice = await api.contextMenu.show(
          [
            { id: "rename", label: "Rename thread" },
            { id: "mark-unread", label: "Mark unread" },
            { id: "copy-path", label: "Copy Path" },
            { id: "copy-thread-id", label: "Copy Thread ID" },
            { id: "archive", label: "Archive thread" },
            { id: "delete", label: "Delete", destructive: true, icon: "trash" },
          ],
          position,
        );
        if (choice === "rename") {
          startRename(thread);
          return;
        }
        if (choice === "archive") {
          const result = await archiveThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to archive thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        if (choice === "mark-unread") {
          markThreadUnread(threadKey, thread.latestTurn?.completedAt);
          return;
        }
        if (choice === "copy-path") {
          if (!thread.worktreePath) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Path unavailable",
                description: "This thread does not have a workspace path to copy.",
              }),
            );
            return;
          }
          copyPathToClipboard(thread.worktreePath, { path: thread.worktreePath });
          return;
        }
        if (choice === "copy-thread-id") {
          copyThreadIdToClipboard(thread.id, { threadId: thread.id });
          return;
        }
        if (choice !== "delete") return;
        if (confirmThreadDelete) {
          const confirmed = await api.dialogs.confirm(
            [
              `Delete thread "${thread.title}"?`,
              "This permanently clears conversation history and removes its worktrees.",
            ].join("\n"),
          );
          if (!confirmed) return;
        }
        const result = await deleteThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [
      archiveThread,
      confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      startRename,
    ],
  );

  const handleDelete = useCallback(async () => {
    await deleteWorkspace({
      environmentId: workspace.environmentId,
      input: { workspaceId: workspace.id, force: true },
    });
  }, [deleteWorkspace, workspace.environmentId, workspace.id]);

  const handleNewWorkspaceThread = useCallback(() => {
    void startWorkspaceThread(workspace);
  }, [startWorkspaceThread, workspace]);

  // Clicking the row toggles the thread list rather than starting a new thread:
  // the pen icon is the single, explicit affordance for "new workspace thread".
  // (Previously the whole row started a thread, so every click minted a fresh
  // draft - the "toggling between threads and new" bug.)
  const handleToggle = useCallback(() => {
    onToggleExpanded(workspace.id);
  }, [onToggleExpanded, workspace.id]);

  return (
    <SidebarMenuItem className="rounded-md">
      <div className="group/workspace-row relative flex items-center">
        <SidebarMenuButton
          className="h-8 gap-1.5 pr-14"
          onClick={handleToggle}
          aria-expanded={expanded}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <BoxesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-xs font-medium text-foreground/90">
              {workspace.title}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/60">
              {memberCount} {memberCount === 1 ? "repo" : "repos"}
            </span>
          </span>
        </SidebarMenuButton>
        <div className="pointer-events-none absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center opacity-0 transition-opacity duration-150 group-hover/workspace-row:pointer-events-auto group-hover/workspace-row:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`New workspace thread in ${workspace.title}`}
                  data-testid="new-workspace-thread-button"
                  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                  onClick={handleNewWorkspaceThread}
                >
                  <SquarePenIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">
              {memberSummary ? `New thread across ${memberSummary}` : "New workspace thread"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Delete workspace ${workspace.title}`}
                  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                  onClick={handleDelete}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">Delete workspace</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {expanded ? (
        threads.length > 0 ? (
          <SidebarMenuSub>
            {threads.map((thread) => {
              const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              const isRenaming = renamingThreadId === thread.id;
              return (
                <SidebarMenuSubItem key={threadKey}>
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renamingTitle}
                      aria-label="Thread title"
                      onChange={(event) => setRenamingTitle(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          event.preventDefault();
                          renameCommittedRef.current = true;
                          commitRename(thread, renamingTitle);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          renameCommittedRef.current = true;
                          setRenamingThreadId(null);
                        }
                      }}
                      onBlur={() => {
                        if (!renameCommittedRef.current) commitRename(thread, renamingTitle);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="ml-1.5 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 py-0.5 text-xs text-foreground outline-none focus:border-foreground"
                    />
                  ) : (
                    <SidebarMenuSubButton
                      size="sm"
                      isActive={threadKey === activeThreadKey}
                      render={
                        <button
                          type="button"
                          title={thread.title}
                          onClick={() => onNavigateThread(thread)}
                          onDoubleClick={(event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                              return;
                            }
                            event.preventDefault();
                            startRename(thread);
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            openThreadContextMenu(thread, {
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        >
                          <span className="truncate">{thread.title}</span>
                        </button>
                      }
                    />
                  )}
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        ) : (
          <div className="mx-3.5 border-sidebar-border border-l py-1 pl-4 text-[11px] text-muted-foreground/50">
            No threads yet
          </div>
        )
      ) : null}
    </SidebarMenuItem>
  );
});

/**
 * Renders the Workspaces group above Projects in the sidebar. Self-contained:
 * reads workspaces from the shell snapshot and owns its create dialog.
 */
export const SidebarWorkspacesContent = memo(function SidebarWorkspacesContent() {
  const workspaces = useWorkspaces();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const routeParams = useParams({ strict: false });
  const [addOpen, setAddOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const activeThreadKey = useMemo(() => {
    const environmentId = routeParams.environmentId;
    const threadId = routeParams.threadId;
    return environmentId && threadId
      ? scopedThreadKey(scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId))
      : null;
  }, [routeParams.environmentId, routeParams.threadId]);

  // Threads whose workspaceId is set belong to a workspace, not to their
  // primary member project - the Projects group filters them out (see
  // Sidebar.tsx threadsByProjectKey), and they are listed here instead.
  const threadsByWorkspaceId = useMemo(() => {
    const map = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of threads) {
      if (thread.workspaceId === null || thread.archivedAt !== null) {
        continue;
      }
      const existing = map.get(thread.workspaceId);
      if (existing) {
        existing.push(thread);
      } else {
        map.set(thread.workspaceId, [thread]);
      }
    }
    // ISO-8601 UTC timestamps sort lexicographically; newest thread first.
    for (const list of map.values()) {
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return map;
  }, [threads]);

  const toggleExpanded = useCallback((workspaceId: WorkspaceId) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }, []);

  const navigateThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );

  return (
    <SidebarGroup className="px-2 pt-2 pb-0">
      <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Workspaces
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Add workspace"
                data-testid="sidebar-add-workspace-trigger"
                className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                onClick={() => setAddOpen(true)}
              >
                <PlusIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="right">Add workspace</TooltipPopup>
        </Tooltip>
      </div>
      {workspaces.length > 0 ? (
        <SidebarMenu>
          {workspaces.map((workspace) => {
            const workspaceThreads = threadsByWorkspaceId.get(workspace.id) ?? [];
            // Keep the workspace open whenever the active thread lives inside it,
            // so navigating to a workspace thread reveals and highlights it.
            const containsActiveThread =
              activeThreadKey !== null &&
              workspaceThreads.some(
                (thread) =>
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                  activeThreadKey,
              );
            return (
              <SidebarWorkspaceRow
                key={`${workspace.environmentId}:${workspace.id}`}
                workspace={workspace}
                threads={workspaceThreads}
                activeThreadKey={activeThreadKey}
                expanded={expandedIds.has(workspace.id) || containsActiveThread}
                onToggleExpanded={toggleExpanded}
                onNavigateThread={navigateThread}
              />
            );
          })}
        </SidebarMenu>
      ) : (
        <button
          type="button"
          className="mx-1 mb-1 rounded-md px-2 py-2 text-left text-xs text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          onClick={() => setAddOpen(true)}
        >
          Group repos into a workspace
        </button>
      )}
      <AddWorkspaceDialog open={addOpen} onOpenChange={setAddOpen} />
    </SidebarGroup>
  );
});
