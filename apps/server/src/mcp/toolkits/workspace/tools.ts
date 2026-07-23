import {
  WorkspaceAttachRepoInput,
  WorkspaceAttachRepoResult,
  WorkspaceListReposResult,
  WorkspaceMcpError,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorkspaceWorktreeBroker } from "../../WorkspaceWorktreeBroker.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, WorkspaceWorktreeBroker];

export const WorkspaceListReposTool = Tool.make("workspace_list_repos", {
  // No parameters: an empty Schema.Struct serializes to a root anyOf, which some
  // providers reject, so omit `parameters` to get a clean `{type:"object"}`.
  description:
    "List every member repository of this workspace thread, showing each label, whether it is currently attached (has a worktree you can edit), and its worktree path. Call this before workspace_attach_repo to discover attachable labels. Only works inside a workspace thread.",
  success: WorkspaceListReposResult,
  failure: WorkspaceMcpError,
  dependencies,
})
  .annotate(Tool.Title, "List workspace repos")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Destructive, false);

export const WorkspaceAttachRepoTool = Tool.make("workspace_attach_repo", {
  description:
    "Attach an additional member repository of this workspace thread by label. This creates the repo's git worktree under the shared workspace root on the shared branch and grants you read/write access to it. The newly attached repo becomes visible on your NEXT turn (the session restarts to pick it up), so finish the current turn after attaching. Call workspace_list_repos first to see available labels. Idempotent: re-attaching a label already attached is a no-op.",
  parameters: WorkspaceAttachRepoInput,
  success: WorkspaceAttachRepoResult,
  failure: WorkspaceMcpError,
  dependencies,
})
  .annotate(Tool.Title, "Attach workspace repo")
  .annotate(Tool.Destructive, false);

export const WorkspaceToolkit = Toolkit.make(WorkspaceListReposTool, WorkspaceAttachRepoTool);
