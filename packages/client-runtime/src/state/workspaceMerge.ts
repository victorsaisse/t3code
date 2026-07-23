import {
  type EnvironmentId as EnvironmentIdType,
  type ThreadId,
  type WorkspaceMergeChangeRequestsInput,
  type WorkspaceMergeMethod,
  type WorkspaceMergeProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import { createRuntimeCommand, runStreamInEnvironment } from "./runtime.ts";

/**
 * Client-side consumer of the streaming `workspace.mergeChangeRequests` RPC:
 * folds per-repo progress events into a threadId-keyed atom the UI renders.
 * A per-repo failure arrives as a stream ITEM (repo_failed), so the panel shows
 * which repo failed and can re-invoke to resume via the server's idempotency.
 */

export type WorkspaceMergeRepoStatus =
  | "pending"
  | "merged"
  | "deploying"
  | "deployed"
  | "skipped"
  | "failed";

export interface WorkspaceMergeRepoState {
  readonly label: string;
  readonly status: WorkspaceMergeRepoStatus;
  readonly message?: string;
}

export interface WorkspaceMergeState {
  readonly isRunning: boolean;
  readonly repos: ReadonlyArray<WorkspaceMergeRepoState>;
  readonly summary: {
    readonly merged: number;
    readonly skipped: number;
    readonly failed: number;
  } | null;
}

export const EMPTY_WORKSPACE_MERGE_STATE: WorkspaceMergeState = {
  isRunning: false,
  repos: [],
  summary: null,
};

function upsertRepo(
  repos: ReadonlyArray<WorkspaceMergeRepoState>,
  next: WorkspaceMergeRepoState,
): ReadonlyArray<WorkspaceMergeRepoState> {
  const index = repos.findIndex((repo) => repo.label === next.label);
  if (index === -1) {
    return [...repos, next];
  }
  const copy = [...repos];
  copy[index] = next;
  return copy;
}

export function applyWorkspaceMergeEvent(
  state: WorkspaceMergeState,
  event: WorkspaceMergeProgressEvent,
): WorkspaceMergeState {
  switch (event._tag) {
    case "repo_started":
      return {
        ...state,
        isRunning: true,
        repos: upsertRepo(state.repos, { label: event.label, status: "pending" }),
      };
    case "repo_merged":
      return { ...state, repos: upsertRepo(state.repos, { label: event.label, status: "merged" }) };
    case "repo_deploying":
      return {
        ...state,
        repos: upsertRepo(state.repos, { label: event.label, status: "deploying" }),
      };
    case "repo_deployed":
      return {
        ...state,
        repos: upsertRepo(state.repos, { label: event.label, status: "deployed" }),
      };
    case "repo_skipped":
      return {
        ...state,
        repos: upsertRepo(state.repos, { label: event.label, status: "skipped" }),
      };
    case "repo_failed":
      return {
        ...state,
        repos: upsertRepo(state.repos, {
          label: event.label,
          status: "failed",
          message: event.message,
        }),
      };
    case "completed":
      return {
        ...state,
        isRunning: false,
        summary: {
          merged: event.mergedCount,
          skipped: event.skippedCount,
          failed: event.failedCount,
        },
      };
  }
}

export const workspaceMergeStateAtom = Atom.family((threadId: string) =>
  Atom.make(EMPTY_WORKSPACE_MERGE_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`workspace-merge:${threadId}`),
  ),
);

export interface MergeWorkspaceInput {
  readonly environmentId: EnvironmentIdType;
  readonly threadId: ThreadId;
  readonly mergeMethod: WorkspaceMergeMethod;
  readonly deleteBranch?: boolean;
  readonly deploy?: boolean;
}

export function createWorkspaceMergeManager<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const mergeWorkspace = createRuntimeCommand<
    EnvironmentRegistry | R,
    E,
    MergeWorkspaceInput,
    void,
    unknown
  >(runtime, {
    label: "workspace-merge:run",
    concurrency: { mode: "serial", key: (input) => input.threadId },
    execute: (input, registry) => {
      const stateAtom = workspaceMergeStateAtom(input.threadId);
      registry.set(stateAtom, { ...EMPTY_WORKSPACE_MERGE_STATE, isRunning: true });
      const rpcInput: WorkspaceMergeChangeRequestsInput = {
        threadId: input.threadId,
        mergeMethod: input.mergeMethod,
        ...(input.deleteBranch !== undefined ? { deleteBranch: input.deleteBranch } : {}),
        ...(input.deploy !== undefined ? { deploy: input.deploy } : {}),
      };
      return runStreamInEnvironment(
        input.environmentId,
        runStream(WS_METHODS.workspaceMergeChangeRequests, rpcInput),
      ).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            registry.set(stateAtom, applyWorkspaceMergeEvent(registry.get(stateAtom), event));
          }),
        ),
        Effect.tapCause(() =>
          Effect.sync(() => {
            registry.set(stateAtom, { ...registry.get(stateAtom), isRunning: false });
          }),
        ),
        Effect.asVoid,
      );
    },
  });

  return { mergeWorkspace, stateAtom: workspaceMergeStateAtom };
}
