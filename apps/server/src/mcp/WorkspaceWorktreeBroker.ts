/**
 * WorkspaceWorktreeBroker - provisions an on-demand member-repo worktree for a
 * workspace thread and records it on the thread. Backs the "workspace" MCP
 * toolkit's lazy-attach tools; it is keyed only on `scope.threadId`, so the
 * agent can attach a repo mid-conversation without the client's involvement.
 *
 * attach() mirrors the eager fan-out in ws.ts (createWorktree under the shared
 * root on the shared branch) for a single label, then dispatches a
 * thread.meta.update that appends the new worktree to thread.worktrees. The
 * newly attached repo becomes editable on the NEXT turn, when the provider
 * session restarts to widen its additionalDirectories (see the reactor's
 * attachedSetChanged trigger).
 */
import {
  CommandId,
  type WorkspaceAttachRepoResult,
  type WorkspaceListReposResult,
  WorkspaceMcpAttachFailedError,
  type WorkspaceMcpError,
  WorkspaceMcpNotWorkspaceThreadError,
  WorkspaceMcpRepoNotFoundError,
  type WorkspaceWorktree,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";

export interface WorkspaceWorktreeBrokerShape {
  readonly attach: (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly label: string;
  }) => Effect.Effect<WorkspaceAttachRepoResult, WorkspaceMcpError>;
  readonly list: (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
  }) => Effect.Effect<WorkspaceListReposResult, WorkspaceMcpError>;
}

export class WorkspaceWorktreeBroker extends Context.Service<
  WorkspaceWorktreeBroker,
  WorkspaceWorktreeBrokerShape
>()("t3/mcp/WorkspaceWorktreeBroker") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitWorkflowService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`mcp:${tag}:${uuid}`)),
      Effect.orDie,
    );

  const attach: WorkspaceWorktreeBrokerShape["attach"] = Effect.fn(
    "WorkspaceWorktreeBroker.attach",
  )(function* ({ scope, label }) {
    const threadId = scope.threadId;
    const threadOption = yield* query.getThreadShellById(threadId).pipe(Effect.orDie);
    const thread = Option.getOrUndefined(threadOption);
    if (
      thread === undefined ||
      thread.workspaceId === null ||
      thread.workspaceRoot === null ||
      thread.branch === null
    ) {
      return yield* new WorkspaceMcpNotWorkspaceThreadError({ threadId });
    }

    const existing = thread.worktrees.find((worktree) => worktree.label === label);
    if (existing) {
      return { ...existing, alreadyAttached: true };
    }

    const workspaceOption = yield* query
      .getWorkspaceShellById(thread.workspaceId)
      .pipe(Effect.orDie);
    const workspace = Option.getOrUndefined(workspaceOption);
    const member = workspace?.members.find((candidate) => candidate.label === label);
    if (workspace === undefined || member === undefined) {
      return yield* new WorkspaceMcpRepoNotFoundError({ threadId, label });
    }

    const projectOption = yield* query.getProjectShellById(member.projectId).pipe(Effect.orDie);
    const project = Option.getOrUndefined(projectOption);
    if (project === undefined) {
      return yield* new WorkspaceMcpRepoNotFoundError({ threadId, label });
    }

    const baseBranch = member.baseBranch ?? "HEAD";
    const sharedBranch = thread.branch;
    const workspaceRoot = thread.workspaceRoot;

    const created = yield* git
      .createWorktree({
        cwd: project.workspaceRoot,
        refName: baseBranch,
        newRefName: sharedBranch,
        baseRefName: baseBranch,
        path: `${workspaceRoot}/${label}`,
      })
      .pipe(
        Effect.mapError(
          (cause) => new WorkspaceMcpAttachFailedError({ threadId, label, detail: cause.message }),
        ),
      );

    const nextWorktree: WorkspaceWorktree = {
      label,
      projectId: member.projectId,
      sourceRepoRoot: project.workspaceRoot,
      repoWorktreePath: created.worktree.path,
      branch: sharedBranch,
      baseBranch,
      deployOrder: member.deployOrder,
    };

    // thread.meta.update replaces the worktrees array verbatim, so append to the
    // existing set - dispatching only the new one would drop prior attachments.
    yield* engine
      .dispatch({
        type: "thread.meta.update",
        commandId: yield* commandId("workspace-attach"),
        threadId,
        worktrees: [...thread.worktrees, nextWorktree],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceMcpAttachFailedError({
              threadId,
              label,
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );

    return { ...nextWorktree, alreadyAttached: false };
  });

  const list: WorkspaceWorktreeBrokerShape["list"] = Effect.fn("WorkspaceWorktreeBroker.list")(
    function* ({ scope }) {
      const threadId = scope.threadId;
      const threadOption = yield* query.getThreadShellById(threadId).pipe(Effect.orDie);
      const thread = Option.getOrUndefined(threadOption);
      if (thread === undefined || thread.workspaceId === null) {
        return yield* new WorkspaceMcpNotWorkspaceThreadError({ threadId });
      }
      const workspaceOption = yield* query
        .getWorkspaceShellById(thread.workspaceId)
        .pipe(Effect.orDie);
      const workspace = Option.getOrUndefined(workspaceOption);
      if (workspace === undefined) {
        return yield* new WorkspaceMcpNotWorkspaceThreadError({ threadId });
      }
      const attachedByLabel = new Map(
        thread.worktrees.map((worktree) => [worktree.label, worktree] as const),
      );
      return {
        repos: workspace.members.map((member) => {
          const attached = attachedByLabel.get(member.label);
          return {
            label: member.label,
            projectId: member.projectId,
            attached: attached !== undefined,
            repoWorktreePath: attached?.repoWorktreePath ?? null,
            baseBranch: member.baseBranch,
            deployOrder: member.deployOrder,
          };
        }),
      };
    },
  );

  return WorkspaceWorktreeBroker.of({ attach, list });
});

export const layer = Layer.effect(WorkspaceWorktreeBroker, make);
