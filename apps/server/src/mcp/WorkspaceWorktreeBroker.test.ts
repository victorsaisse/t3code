import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type OrchestrationWorkspaceShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceId,
  WorkspaceMcpNotWorkspaceThreadError,
  WorkspaceMcpRepoNotFoundError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as WorkspaceWorktreeBroker from "./WorkspaceWorktreeBroker.ts";

const THREAD_ID = ThreadId.make("thread-ws");
const WORKSPACE_ID = WorkspaceId.make("workspace-1");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["workspace"]),
  issuedAt: 1,
  expiresAt: 2,
};

// The broker only reads workspaceId/workspaceRoot/branch/worktrees off the
// thread shell, so build a minimal shell and cast to the full type.
function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    workspaceId: WORKSPACE_ID,
    workspaceRoot: "/tmp/ws/thread-ws",
    branch: "t3code/shared",
    worktrees: [
      {
        label: "wsrepo-a",
        projectId: PROJECT_A,
        sourceRepoRoot: "/tmp/wsrepo-a",
        repoWorktreePath: "/tmp/ws/thread-ws/wsrepo-a",
        branch: "t3code/shared",
        baseBranch: "main",
        deployOrder: 0,
      },
    ],
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

const workspace = {
  id: WORKSPACE_ID,
  title: "Debug WS",
  members: [
    { projectId: PROJECT_A, label: "wsrepo-a", baseBranch: "main", deployOrder: 0 },
    { projectId: PROJECT_B, label: "wsrepo-b", baseBranch: "main", deployOrder: 1 },
  ],
} as unknown as OrchestrationWorkspaceShell;

const projectB = {
  id: PROJECT_B,
  title: "wsrepo-b",
  workspaceRoot: "/tmp/wsrepo-b",
} as unknown as OrchestrationProjectShell;

function makeQuery(
  thread: OrchestrationThreadShell,
): ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] {
  return {
    getThreadShellById: () => Effect.succeed(Option.some(thread)),
    getWorkspaceShellById: () => Effect.succeed(Option.some(workspace)),
    getProjectShellById: () => Effect.succeed(Option.some(projectB)),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
}

function makeEngine(
  dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
): OrchestrationEngine.OrchestrationEngineService["Service"] {
  return {
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) =>
      Ref.update(dispatched, (calls) => [...calls, command]).pipe(Effect.as({ sequence: 1 })),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } satisfies OrchestrationEngine.OrchestrationEngineService["Service"];
}

const git = {
  createWorktree: (input: { readonly path?: string }) =>
    Effect.succeed({
      worktree: { path: input.path ?? "/tmp/ws/thread-ws/wsrepo-b", refName: "t3code/shared" },
    }),
} as unknown as GitWorkflowService["Service"];

function runAttach(thread: OrchestrationThreadShell, label: string) {
  return Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const exit = yield* WorkspaceWorktreeBroker.WorkspaceWorktreeBroker.pipe(
      Effect.flatMap((broker) => broker.attach({ scope, label })),
      Effect.provide(WorkspaceWorktreeBroker.layer),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, makeQuery(thread)),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(dispatched)),
      Effect.provideService(GitWorkflowService, git),
      Effect.provide(NodeServices.layer),
      Effect.exit,
    );
    const commands = yield* Ref.get(dispatched);
    return { exit, commands };
  });
}

it.effect("attach provisions a new member worktree and appends it to thread.worktrees", () =>
  Effect.gen(function* () {
    const { exit, commands } = yield* runAttach(makeThread(), "wsrepo-b");
    assert.isTrue(Exit.isSuccess(exit), "attach should succeed");
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.label).toBe("wsrepo-b");
    expect(exit.value.alreadyAttached).toBe(false);
    expect(exit.value.repoWorktreePath).toBe("/tmp/ws/thread-ws/wsrepo-b");
    expect(exit.value.branch).toBe("t3code/shared");
    expect(exit.value.deployOrder).toBe(1);

    // Exactly one thread.meta.update whose worktrees is the FULL appended set.
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.type).toBe("thread.meta.update");
    const worktrees = (command as { worktrees?: ReadonlyArray<{ label: string }> }).worktrees ?? [];
    expect(worktrees.map((w) => w.label)).toEqual(["wsrepo-a", "wsrepo-b"]);
  }),
);

it.effect("attach is idempotent for an already-attached label and dispatches nothing", () =>
  Effect.gen(function* () {
    const { exit, commands } = yield* runAttach(makeThread(), "wsrepo-a");
    assert.isTrue(Exit.isSuccess(exit));
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.alreadyAttached).toBe(true);
    expect(exit.value.label).toBe("wsrepo-a");
    expect(commands).toHaveLength(0);
  }),
);

it.effect("attach of an unknown label fails with WorkspaceMcpRepoNotFoundError", () =>
  Effect.gen(function* () {
    const { exit, commands } = yield* runAttach(makeThread(), "nope");
    assert.isTrue(Exit.isFailure(exit));
    if (!Exit.isFailure(exit)) return;
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(WorkspaceMcpRepoNotFoundError);
    expect(commands).toHaveLength(0);
  }),
);

it.effect("attach on a non-workspace thread fails with WorkspaceMcpNotWorkspaceThreadError", () =>
  Effect.gen(function* () {
    const thread = makeThread({ workspaceId: null, workspaceRoot: null });
    const { exit, commands } = yield* runAttach(thread, "wsrepo-b");
    assert.isTrue(Exit.isFailure(exit));
    if (!Exit.isFailure(exit)) return;
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(WorkspaceMcpNotWorkspaceThreadError);
    expect(commands).toHaveLength(0);
  }),
);
