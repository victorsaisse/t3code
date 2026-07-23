import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewAutomationUnavailableError } from "./previewAutomation.ts";

/**
 * Schema-only contracts for the in-app "workspace" MCP toolkit (M4 lazy attach).
 * The tools let a workspace-thread agent discover its member repos and attach an
 * additional one on demand; attaching provisions the member's git worktree and
 * records it on the thread so the next turn can edit it.
 */

export const WorkspaceAttachRepoInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description:
      "The workspace member repo label to attach (e.g. 'api'). Must be one of the labels returned by workspace_list_repos.",
  }),
});
export type WorkspaceAttachRepoInput = typeof WorkspaceAttachRepoInput.Type;

export const WorkspaceAttachRepoResult = Schema.Struct({
  label: TrimmedNonEmptyString,
  projectId: ProjectId,
  repoWorktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  deployOrder: NonNegativeInt,
  // true when the label was already attached (idempotent no-op, no new worktree).
  alreadyAttached: Schema.Boolean,
});
export type WorkspaceAttachRepoResult = typeof WorkspaceAttachRepoResult.Type;

export const WorkspaceRepoListItem = Schema.Struct({
  label: TrimmedNonEmptyString,
  projectId: ProjectId,
  attached: Schema.Boolean,
  repoWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  deployOrder: NonNegativeInt,
});
export type WorkspaceRepoListItem = typeof WorkspaceRepoListItem.Type;

export const WorkspaceListReposResult = Schema.Struct({
  repos: Schema.Array(WorkspaceRepoListItem),
});
export type WorkspaceListReposResult = typeof WorkspaceListReposResult.Type;

export class WorkspaceMcpNotWorkspaceThreadError extends Schema.TaggedErrorClass<WorkspaceMcpNotWorkspaceThreadError>()(
  "WorkspaceMcpNotWorkspaceThreadError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' is not a workspace thread; workspace repo tools are unavailable.`;
  }
}

export class WorkspaceMcpRepoNotFoundError extends Schema.TaggedErrorClass<WorkspaceMcpRepoNotFoundError>()(
  "WorkspaceMcpRepoNotFoundError",
  {
    threadId: ThreadId,
    label: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Workspace member '${this.label}' was not found on thread '${this.threadId}'.`;
  }
}

export class WorkspaceMcpAttachFailedError extends Schema.TaggedErrorClass<WorkspaceMcpAttachFailedError>()(
  "WorkspaceMcpAttachFailedError",
  {
    threadId: ThreadId,
    label: TrimmedNonEmptyString,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to attach workspace member '${this.label}' to thread '${this.threadId}': ${this.detail}`;
  }
}

export const WorkspaceMcpError = Schema.Union([
  PreviewAutomationUnavailableError,
  WorkspaceMcpNotWorkspaceThreadError,
  WorkspaceMcpRepoNotFoundError,
  WorkspaceMcpAttachFailedError,
]);
export type WorkspaceMcpError = typeof WorkspaceMcpError.Type;
