import { describe, expect, it } from "vite-plus/test";
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  validateMemberWorktreePath,
} from "./path.ts";

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });
});

describe("validateMemberWorktreePath", () => {
  const root = "/home/u/.t3/worktrees/workspaces/thread-abc";

  it("accepts a short safe label", () => {
    expect(validateMemberWorktreePath({ label: "api", workspaceThreadRoot: root }).ok).toBe(true);
  });

  it("rejects an over-long label", () => {
    expect(
      validateMemberWorktreePath({ label: "x".repeat(33), workspaceThreadRoot: root }),
    ).toMatchObject({ ok: false, issue: "label-too-long" });
  });

  it("rejects an empty label", () => {
    expect(validateMemberWorktreePath({ label: "  ", workspaceThreadRoot: root }).issue).toBe(
      "label-empty",
    );
  });

  it("rejects a label with a path separator or traversal", () => {
    expect(validateMemberWorktreePath({ label: "a/b", workspaceThreadRoot: root }).issue).toBe(
      "label-unsafe",
    );
    expect(validateMemberWorktreePath({ label: "..", workspaceThreadRoot: root }).issue).toBe(
      "label-unsafe",
    );
    expect(validateMemberWorktreePath({ label: "a\\b", workspaceThreadRoot: root }).issue).toBe(
      "label-unsafe",
    );
  });

  it("rejects when the total worktree path exceeds the ceiling", () => {
    const deep = "/" + "d/".repeat(160);
    expect(validateMemberWorktreePath({ label: "api", workspaceThreadRoot: deep }).issue).toBe(
      "path-too-long",
    );
  });
});
