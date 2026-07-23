import type {
  GitRunStackedActionResult,
  VcsStatusResult,
  WorkspaceWorktree,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isWorktreeShippable,
  resolveShipPrUrl,
  resolveWorkspaceShipBranch,
  summarizeWorkspaceShip,
} from "./workspaceShip.ts";

function makeWorktree(overrides: Partial<WorkspaceWorktree> = {}): WorkspaceWorktree {
  return {
    label: "wsrepo-a",
    projectId: "project-a" as WorkspaceWorktree["projectId"],
    sourceRepoRoot: "/tmp/wsrepo-a",
    repoWorktreePath: "/tmp/ws/wsrepo-a",
    branch: "t3code/shared",
    baseBranch: "main",
    deployOrder: 0,
    ...overrides,
  };
}

// The pure helpers only read `hasWorkingTreeChanges`/`aheadCount` (status) and
// `pr.status`/`pr.url`/`toast.cta` (result), so the fixtures build just those
// fields and cast through `unknown` rather than fully constructing the schemas.
function makeStatus(hasWorkingTreeChanges: boolean, aheadCount: number): VcsStatusResult {
  return { hasWorkingTreeChanges, aheadCount } as unknown as VcsStatusResult;
}

function makeResult(overrides: {
  prStatus?: GitRunStackedActionResult["pr"]["status"];
  prUrl?: string;
  ctaKind?: GitRunStackedActionResult["toast"]["cta"]["kind"];
  ctaUrl?: string;
}): GitRunStackedActionResult {
  const cta =
    overrides.ctaKind === "open_pr"
      ? { kind: "open_pr" as const, label: "Open PR", url: overrides.ctaUrl ?? "https://x/pr/1" }
      : { kind: "none" as const };
  return {
    pr: {
      status: overrides.prStatus ?? "skipped_not_requested",
      ...(overrides.prUrl ? { url: overrides.prUrl } : {}),
    },
    toast: { title: "Shipped", cta },
  } as unknown as GitRunStackedActionResult;
}

describe("resolveWorkspaceShipBranch", () => {
  it("returns the single shared branch across N worktrees", () => {
    expect(
      resolveWorkspaceShipBranch([
        makeWorktree({ label: "a", branch: "t3code/shared" }),
        makeWorktree({ label: "b", branch: "t3code/shared" }),
      ]),
    ).toBe("t3code/shared");
  });

  it("returns null for an empty worktree list", () => {
    expect(resolveWorkspaceShipBranch([])).toBe(null);
  });
});

describe("isWorktreeShippable", () => {
  it("is true when the working tree has changes", () => {
    expect(isWorktreeShippable(makeStatus(true, 0))).toBe(true);
  });

  it("is true when there are unpushed commits (aheadCount > 0)", () => {
    expect(isWorktreeShippable(makeStatus(false, 2))).toBe(true);
  });

  it("is false for a clean, up-to-date repo (filtered out, not shipped)", () => {
    expect(isWorktreeShippable(makeStatus(false, 0))).toBe(false);
  });
});

describe("resolveShipPrUrl", () => {
  it("prefers the open_pr CTA url", () => {
    expect(
      resolveShipPrUrl(
        makeResult({ ctaKind: "open_pr", ctaUrl: "https://gh/pr/7", prUrl: "https://gh/pr/other" }),
      ),
    ).toBe("https://gh/pr/7");
  });

  it("falls back to pr.url when the CTA is not open_pr", () => {
    expect(
      resolveShipPrUrl(
        makeResult({ ctaKind: "none", prStatus: "created", prUrl: "https://gh/pr/9" }),
      ),
    ).toBe("https://gh/pr/9");
  });

  it("returns null when no PR was opened", () => {
    expect(
      resolveShipPrUrl(makeResult({ ctaKind: "none", prStatus: "skipped_not_requested" })),
    ).toBe(null);
  });
});

describe("summarizeWorkspaceShip", () => {
  it("folds mixed outcomes into correct counts and groupings", () => {
    const summary = summarizeWorkspaceShip([
      { label: "a", prUrl: "https://gh/pr/1", error: null },
      { label: "b", prUrl: null, error: "push rejected" },
      { label: "c", prUrl: "https://gh/pr/3", error: null },
    ]);
    expect(summary.shipped).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.openPrs).toEqual([
      { label: "a", url: "https://gh/pr/1" },
      { label: "c", url: "https://gh/pr/3" },
    ]);
    expect(summary.failures).toEqual([{ label: "b", message: "push rejected" }]);
  });

  it("treats a shipped repo with no PR url as shipped but not in openPrs", () => {
    const summary = summarizeWorkspaceShip([{ label: "a", prUrl: null, error: null }]);
    expect(summary.shipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.openPrs).toEqual([]);
  });
});
