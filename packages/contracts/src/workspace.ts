import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// A repo participating in a workspace (references an existing Project).
export const WorkspaceMember = Schema.Struct({
  // inherit workspaceRoot / identity / scripts from the referenced Project
  projectId: ProjectId,
  // subfolder name + role; unique within the workspace
  label: TrimmedNonEmptyString,
  // null => resolve the repo default branch at bootstrap
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  // ordered merge/deploy sequence
  deployOrder: NonNegativeInt,
});
export type WorkspaceMember = typeof WorkspaceMember.Type;

// One live per-repo worktree bound to a workspace thread.
export const WorkspaceWorktree = Schema.Struct({
  // matches WorkspaceMember.label
  label: TrimmedNonEmptyString,
  projectId: ProjectId,
  // owning repo; cwd for `git worktree add/remove`
  sourceRepoRoot: TrimmedNonEmptyString,
  // absolute: <workspaceRoot>/<label>
  repoWorktreePath: TrimmedNonEmptyString,
  // shared auto branch t3code/<slug>
  branch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  deployOrder: NonNegativeInt,
});
export type WorkspaceWorktree = typeof WorkspaceWorktree.Type;
