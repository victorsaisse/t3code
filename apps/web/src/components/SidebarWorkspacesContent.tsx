import type { EnvironmentWorkspace } from "@t3tools/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { WorkspaceMember } from "@t3tools/contracts";
import { BoxesIcon, LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { newWorkspaceId } from "../lib/utils";
import { useProjects, useWorkspaces } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { workspaceEnvironment } from "../state/workspaces";
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
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
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
      .slice(0, 32) || `repo-${index + 1}`;
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
}) {
  const { workspace } = props;
  const deleteWorkspace = useAtomCommand(workspaceEnvironment.delete, { reportFailure: false });
  const memberCount = workspace.members.length;
  const memberSummary = workspace.members.map((member) => member.label).join(" · ");

  const handleDelete = useCallback(async () => {
    await deleteWorkspace({
      environmentId: workspace.environmentId,
      input: { workspaceId: workspace.id, force: true },
    });
  }, [deleteWorkspace, workspace.environmentId, workspace.id]);

  return (
    <SidebarMenuItem className="rounded-md">
      <div className="group/workspace-row relative flex items-center">
        <SidebarMenuButton className="h-8 gap-2 pr-8">
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
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Delete workspace ${workspace.title}`}
                className={`absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/workspace-row:opacity-100 ${SIDEBAR_ICON_ACTION_BUTTON_CLASS}`}
                onClick={handleDelete}
              >
                <Trash2Icon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="top">{memberSummary || "Delete workspace"}</TooltipPopup>
        </Tooltip>
      </div>
    </SidebarMenuItem>
  );
});

/**
 * Renders the Workspaces group above Projects in the sidebar. Self-contained:
 * reads workspaces from the shell snapshot and owns its create dialog.
 */
export const SidebarWorkspacesContent = memo(function SidebarWorkspacesContent() {
  const workspaces = useWorkspaces();
  const [addOpen, setAddOpen] = useState(false);

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
          {workspaces.map((workspace) => (
            <SidebarWorkspaceRow
              key={`${workspace.environmentId}:${workspace.id}`}
              workspace={workspace}
            />
          ))}
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
