import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

/**
 * Decides whether `workspaceRoot` is the exact shared root a workspace thread
 * owns (`<workspacesDir>/<threadId>`) and is therefore safe to remove
 * recursively. Both sides are resolved first, so a malformed or malicious event
 * can never delete a path outside the workspaces directory - `..` traversal, a
 * mismatched threadId, or a sibling path all resolve to something other than
 * the single expected root and are rejected. `resolve`/`join` are injected so
 * the decision stays pure and unit-testable.
 */
export function isWorkspaceThreadSharedRoot(input: {
  readonly workspaceRoot: string;
  readonly workspacesDir: string;
  readonly threadId: string;
  readonly resolve: (path: string) => string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
}): boolean {
  const expected = input.resolve(input.join(input.workspacesDir, input.threadId));
  return input.resolve(input.workspaceRoot) === expected;
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  // Workspace threads own one git worktree per member repo under a shared root
  // (`worktreesDir/workspaces/<threadId>`). Remove each member worktree from its
  // owning repo, then delete the now-empty shared root. Every step is
  // best-effort so one failing repo never blocks the rest of the cleanup. The
  // shared-root removal is guarded to the exact expected path so a malformed
  // event can never delete anything outside the workspaces directory.
  const cleanupWorkspaceWorktrees = Effect.fn("cleanupWorkspaceWorktrees")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    const workspaceRoot = event.payload.workspaceRoot ?? null;
    const worktrees = event.payload.worktrees ?? [];
    if (worktrees.length === 0 && workspaceRoot === null) {
      return;
    }

    yield* Effect.forEach(
      worktrees,
      (worktree) =>
        logCleanupCauseUnlessInterrupted({
          effect: gitWorkflow.removeWorktree({
            cwd: worktree.sourceRepoRoot,
            path: worktree.repoWorktreePath,
            force: true,
          }),
          message: "workspace thread deletion skipped member worktree removal",
          threadId,
        }),
      { concurrency: 1, discard: true },
    );

    if (workspaceRoot !== null) {
      if (
        isWorkspaceThreadSharedRoot({
          workspaceRoot,
          workspacesDir: config.workspacesDir,
          threadId,
          resolve: path.resolve,
          join: path.join,
        })
      ) {
        yield* logCleanupCauseUnlessInterrupted({
          effect: fileSystem.remove(workspaceRoot, { recursive: true, force: true }),
          message: "workspace thread deletion skipped shared root removal",
          threadId,
        });
      } else {
        yield* Effect.logWarning(
          "workspace thread deletion skipped shared root removal: path outside workspaces dir",
          { threadId, workspaceRoot, workspacesDir: config.workspacesDir },
        );
      }
    }
  });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* cleanupWorkspaceWorktrees(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
