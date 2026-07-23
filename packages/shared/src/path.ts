export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]?$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }
  const trimmed = value.startsWith("/")
    ? value.replace(/\/+$/g, "")
    : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || isUncPath(normalized)) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

// ---- Workspace member worktree path validation (M6 #635) ----

// OS ceilings: NAME_MAX 255 per segment; Windows legacy MAX_PATH 260; POSIX
// PATH_MAX ~1024. Stay well under the strictest common ceiling and keep each
// member label to ONE filesystem-safe path segment (one-level subfolder).
export const MAX_MEMBER_LABEL_LENGTH = 32;
export const MAX_WORKTREE_PATH_LENGTH = 240;

export type MemberWorktreePathIssue =
  | "label-empty"
  | "label-too-long"
  | "label-unsafe"
  | "path-too-long";

export interface MemberWorktreePathValidation {
  readonly ok: boolean;
  readonly issue?: MemberWorktreePathIssue;
  readonly worktreePathLength: number;
}

const UNSAFE_LABEL_PATTERN = new RegExp(`[\\\\/${String.fromCharCode(0)}]`);

/**
 * Guardrail (not an OS-exact guarantee) that a workspace member's label is a
 * single filesystem-safe segment and its worktree path `<root>/<label>` stays
 * under a conservative length ceiling, so provisioning fails cleanly per-repo
 * instead of aborting the whole workspace bootstrap on a deep path.
 */
export function validateMemberWorktreePath(input: {
  readonly label: string;
  readonly workspaceThreadRoot: string;
  readonly separator?: string;
}): MemberWorktreePathValidation {
  const separator = input.separator ?? "/";
  const label = input.label.trim();
  const worktreePathLength = input.workspaceThreadRoot.length + separator.length + label.length;
  if (label.length === 0) {
    return { ok: false, issue: "label-empty", worktreePathLength };
  }
  if (label.length > MAX_MEMBER_LABEL_LENGTH) {
    return { ok: false, issue: "label-too-long", worktreePathLength };
  }
  // A single, filesystem-safe segment: no separators, traversal, or NUL.
  if (label === "." || label === ".." || UNSAFE_LABEL_PATTERN.test(label)) {
    return { ok: false, issue: "label-unsafe", worktreePathLength };
  }
  if (worktreePathLength > MAX_WORKTREE_PATH_LENGTH) {
    return { ok: false, issue: "path-too-long", worktreePathLength };
  }
  return { ok: true, worktreePathLength };
}
