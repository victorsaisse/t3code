import type { WorkspaceMergeProgressEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyWorkspaceMergeEvent,
  EMPTY_WORKSPACE_MERGE_STATE,
  type WorkspaceMergeState,
} from "./workspaceMerge.ts";

function fold(events: ReadonlyArray<WorkspaceMergeProgressEvent>): WorkspaceMergeState {
  return events.reduce(applyWorkspaceMergeEvent, EMPTY_WORKSPACE_MERGE_STATE);
}

describe("applyWorkspaceMergeEvent", () => {
  it("folds a full successful run into merged repos and a completed summary", () => {
    const state = fold([
      { _tag: "repo_started", label: "api", deployOrder: 0 },
      { _tag: "repo_merged", label: "api", deployOrder: 0, prNumber: 1, prUrl: "https://x/1" },
      { _tag: "repo_started", label: "web", deployOrder: 1 },
      { _tag: "repo_merged", label: "web", deployOrder: 1 },
      { _tag: "completed", mergedCount: 2, skippedCount: 0, failedCount: 0 },
    ]);
    expect(state.isRunning).toBe(false);
    expect(state.repos).toEqual([
      { label: "api", status: "merged" },
      { label: "web", status: "merged" },
    ]);
    expect(state.summary).toEqual({ merged: 2, skipped: 0, failed: 0 });
  });

  it("records a per-repo failure with its message and keeps isRunning until completed", () => {
    const midRun = fold([
      { _tag: "repo_started", label: "api", deployOrder: 0 },
      { _tag: "repo_merged", label: "api", deployOrder: 0 },
      { _tag: "repo_started", label: "web", deployOrder: 1 },
      { _tag: "repo_failed", label: "web", deployOrder: 1, phase: "merge", message: "conflict" },
    ]);
    expect(midRun.isRunning).toBe(true);
    expect(midRun.repos.find((r) => r.label === "web")).toEqual({
      label: "web",
      status: "failed",
      message: "conflict",
    });

    const finished = applyWorkspaceMergeEvent(midRun, {
      _tag: "completed",
      mergedCount: 1,
      skippedCount: 0,
      failedCount: 1,
    });
    expect(finished.isRunning).toBe(false);
    expect(finished.summary).toEqual({ merged: 1, skipped: 0, failed: 1 });
  });

  it("transitions a repo through deploying -> deployed", () => {
    const state = fold([
      { _tag: "repo_started", label: "api", deployOrder: 0 },
      { _tag: "repo_merged", label: "api", deployOrder: 0 },
      { _tag: "repo_deploying", label: "api", deployOrder: 0 },
      { _tag: "repo_deployed", label: "api", deployOrder: 0 },
    ]);
    expect(state.repos).toEqual([{ label: "api", status: "deployed" }]);
  });

  it("marks skipped repos and upserts unknown labels rather than dropping them", () => {
    const state = fold([
      { _tag: "repo_skipped", label: "api", deployOrder: 0, reason: "already-merged" },
    ]);
    expect(state.repos).toEqual([{ label: "api", status: "skipped" }]);
  });
});
