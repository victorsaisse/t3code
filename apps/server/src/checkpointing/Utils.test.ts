import { ProjectId, ThreadId, type WorkspaceWorktree } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnScoped,
  checkpointRepoTargetsFromWorktrees,
} from "./Utils.ts";

const threadId = ThreadId.make("thread-abc");

function worktree(label: string, deployOrder: number): WorkspaceWorktree {
  return {
    label,
    projectId: ProjectId.make(`project-${label}`),
    sourceRepoRoot: `/repos/${label}`,
    repoWorktreePath: `/ws/thread-abc/${label}`,
    branch: "t3code/shared",
    baseBranch: "main",
    deployOrder,
  };
}

describe("checkpointRefForThreadTurnScoped", () => {
  it("is byte-identical to the legacy ref when label is null (single-repo unchanged)", () => {
    expect(checkpointRefForThreadTurnScoped(threadId, 3, null)).toBe(
      checkpointRefForThreadTurn(threadId, 3),
    );
    expect(checkpointRefForThreadTurnScoped(threadId, 3)).toBe(
      checkpointRefForThreadTurn(threadId, 3),
    );
  });

  it("inserts a /repo/<encoded-label> segment and differs per label", () => {
    const api = checkpointRefForThreadTurnScoped(threadId, 1, "api");
    const web = checkpointRefForThreadTurnScoped(threadId, 1, "web");
    expect(api).toContain("/repo/");
    expect(api).not.toBe(web);
    expect(api).not.toBe(checkpointRefForThreadTurn(threadId, 1));
    // deterministic: same inputs -> same ref
    expect(checkpointRefForThreadTurnScoped(threadId, 1, "api")).toBe(api);
  });
});

describe("checkpointRepoTargetsFromWorktrees", () => {
  it("sorts by deployOrder and maps repoWorktreePath->cwd, label->label", () => {
    const targets = checkpointRepoTargetsFromWorktrees([
      worktree("web", 2),
      worktree("api", 0),
      worktree("mobile", 1),
    ]);
    expect(targets).toStrictEqual([
      { label: "api", cwd: "/ws/thread-abc/api" },
      { label: "mobile", cwd: "/ws/thread-abc/mobile" },
      { label: "web", cwd: "/ws/thread-abc/web" },
    ]);
  });
});
