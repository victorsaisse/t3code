// @effect-diagnostics nodeBuiltinImport:off
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceThreadSharedRoot,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("isWorkspaceThreadSharedRoot", () => {
  const workspacesDir = "/home/user/.t3/worktrees/workspaces";
  const threadId = "thread-abc123";
  const guard = (workspaceRoot: string) =>
    isWorkspaceThreadSharedRoot({
      workspaceRoot,
      workspacesDir,
      threadId,
      resolve: NodePath.resolve,
      join: NodePath.join,
    });

  it("accepts the exact expected shared root", () => {
    expect(guard(NodePath.join(workspacesDir, threadId))).toBe(true);
  });

  it("accepts an unnormalized but equivalent path (trailing slash, dot segments)", () => {
    expect(guard(`${workspacesDir}/${threadId}/`)).toBe(true);
    expect(guard(`${workspacesDir}/./${threadId}`)).toBe(true);
  });

  it("rejects a different threadId's root", () => {
    expect(guard(NodePath.join(workspacesDir, "some-other-thread"))).toBe(false);
  });

  it("rejects a parent-traversal path that escapes the workspaces dir", () => {
    expect(guard(`${workspacesDir}/${threadId}/../../../etc`)).toBe(false);
    expect(guard("/etc")).toBe(false);
  });

  it("rejects a subdirectory of the expected root (only the root itself is removable)", () => {
    expect(guard(NodePath.join(workspacesDir, threadId, "wsrepo-a"))).toBe(false);
  });

  it("rejects the workspaces dir itself", () => {
    expect(guard(workspacesDir)).toBe(false);
  });
});
