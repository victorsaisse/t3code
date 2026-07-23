// @effect-diagnostics globalErrorInEffectFailure:off
import { expect, it } from "@effect/vitest";
import type {
  GitMergeChangeRequestResult,
  WorkspaceMergeProgressEvent,
  WorkspaceWorktree,
} from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { runOrderedMerge, sortWorktreesByDeployOrder } from "./WorkspaceMergeOrchestrator.ts";

function makeWorktree(label: string, deployOrder: number): WorkspaceWorktree {
  return {
    label,
    projectId: ProjectId.make(`project-${label}`),
    sourceRepoRoot: `/tmp/${label}`,
    repoWorktreePath: `/tmp/ws/${label}`,
    branch: "t3code/shared",
    baseBranch: "main",
    deployOrder,
  };
}

const merged: GitMergeChangeRequestResult = { status: "merged", prNumber: 1, prUrl: "https://x/1" };
const alreadyMerged: GitMergeChangeRequestResult = { status: "skipped_already_merged" };

function harness() {
  return Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<WorkspaceMergeProgressEvent>>([]);
    const emit = (event: WorkspaceMergeProgressEvent) =>
      Ref.update(events, (list) => [...list, event]);
    return { events, emit };
  });
}

it("sortWorktreesByDeployOrder orders ascending regardless of input order", () => {
  const sorted = sortWorktreesByDeployOrder([
    makeWorktree("web", 2),
    makeWorktree("api", 0),
    makeWorktree("mobile", 1),
  ]);
  expect(sorted.map((w) => w.label)).toEqual(["api", "mobile", "web"]);
});

it.effect("merges every repo in deployOrder and emits a completed summary", () =>
  Effect.gen(function* () {
    const { events, emit } = yield* harness();
    yield* runOrderedMerge(
      [makeWorktree("web", 2), makeWorktree("api", 0), makeWorktree("mobile", 1)],
      {
        mergeRepo: () => Effect.succeed(merged),
        emit,
      },
    );
    const log = yield* Ref.get(events);
    const mergedOrder = log
      .filter((e) => e._tag === "repo_merged")
      .map((e) => (e as { label: string }).label);
    expect(mergedOrder).toEqual(["api", "mobile", "web"]);
    const completed = log.at(-1);
    expect(completed).toEqual({
      _tag: "completed",
      mergedCount: 3,
      skippedCount: 0,
      failedCount: 0,
    });
  }),
);

it.effect("stops at the first failed repo and leaves later repos untouched", () =>
  Effect.gen(function* () {
    const attempted: string[] = [];
    const { events, emit } = yield* harness();
    yield* runOrderedMerge(
      [makeWorktree("api", 0), makeWorktree("web", 1), makeWorktree("mobile", 2)],
      {
        mergeRepo: (wt) => {
          attempted.push(wt.label);
          return wt.label === "web"
            ? Effect.fail(new Error("merge conflict"))
            : Effect.succeed(merged);
        },
        emit,
      },
    );
    // api attempted+merged, web attempted+failed, mobile NEVER attempted.
    expect(attempted).toEqual(["api", "web"]);
    const log = yield* Ref.get(events);
    const failed = log.find((e) => e._tag === "repo_failed") as
      | { label: string; phase: string; message: string }
      | undefined;
    expect(failed).toMatchObject({ label: "web", phase: "merge", message: "merge conflict" });
    expect(log.at(-1)).toEqual({
      _tag: "completed",
      mergedCount: 1,
      skippedCount: 0,
      failedCount: 1,
    });
  }),
);

it.effect("skips already-merged repos and continues", () =>
  Effect.gen(function* () {
    const { events, emit } = yield* harness();
    yield* runOrderedMerge([makeWorktree("api", 0), makeWorktree("web", 1)], {
      mergeRepo: (wt) =>
        wt.label === "api" ? Effect.succeed(alreadyMerged) : Effect.succeed(merged),
      emit,
    });
    const log = yield* Ref.get(events);
    expect(log.find((e) => e._tag === "repo_skipped")).toMatchObject({
      label: "api",
      reason: "already-merged",
    });
    expect(log.at(-1)).toEqual({
      _tag: "completed",
      mergedCount: 1,
      skippedCount: 1,
      failedCount: 0,
    });
  }),
);

it.effect("runs deploy after each merge and halts when a deploy fails", () =>
  Effect.gen(function* () {
    const deployed: string[] = [];
    const { events, emit } = yield* harness();
    yield* runOrderedMerge(
      [makeWorktree("api", 0), makeWorktree("web", 1), makeWorktree("mobile", 2)],
      {
        mergeRepo: () => Effect.succeed(merged),
        deployRepo: (wt) => {
          if (wt.label === "web") return Effect.fail(new Error("deploy timeout"));
          deployed.push(wt.label);
          return Effect.void;
        },
        emit,
      },
    );
    expect(deployed).toEqual(["api"]); // web deploy failed, mobile never reached
    const log = yield* Ref.get(events);
    expect(log.find((e) => e._tag === "repo_failed")).toMatchObject({
      label: "web",
      phase: "deploy",
    });
    expect(
      log.filter((e) => e._tag === "repo_deployed").map((e) => (e as { label: string }).label),
    ).toEqual(["api"]);
  }),
);
