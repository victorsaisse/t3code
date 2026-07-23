import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  WorkspaceMergeMethod,
  WorkspaceWorktree,
} from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import {
  BoxesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileDiffIcon,
  GitMergeIcon,
  PilcrowIcon,
  UploadCloudIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { type DraftId } from "../composerDraftStore";
import { useTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import {
  buildFileDiffRenderKey,
  DIFF_RENDER_UNSAFE_CSS,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import {
  isWorktreeShippable,
  resolveShipPrUrl,
  resolveWorkspaceShipBranch,
  summarizeWorkspaceShip,
  type WorkspaceShipEntry,
} from "../lib/workspaceShip";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { cn, randomUUID } from "~/lib/utils";
import { useThread } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { reviewEnvironment } from "../state/review";
import { vcsActionManager, vcsEnvironment, workspaceMergeManager } from "../state/vcs";
import { resolveThreadRouteRef } from "../threadRoutes";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Toggle } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type DiffThemeType = "light" | "dark";

type ScopedThreadRefOrDraft = ScopedThreadRef | DraftId;

interface WorkspaceDiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRefOrDraft;
}

/**
 * One drill-in navigator for all workspace member repos. Each repo has its own
 * git worktree (`repoWorktreePath`), so the single-repo DiffPanel - which reads
 * one `cwd` - can only ever show one of them (and would run git on the non-git
 * shared root). This panel fans out one `diffPreview` query per worktree, shows
 * a repo list (with per-repo change counts), then drills in: pick a repo to see
 * its changed files, pick a file to see that file's code diff. Replaces the old
 * "stack every repo's full diff in one scroll" layout, which buried repos and
 * scrolled forever.
 */
const MERGE_STATUS_LABEL: Record<string, string> = {
  pending: "Merging…",
  merged: "Merged",
  deploying: "Deploying…",
  deployed: "Deployed",
  skipped: "Skipped",
  failed: "Failed",
};

// Progressive per-repo change summary reported up from each worktree child once
// its diff query resolves, so the repo list can show counts without the parent
// violating rules-of-hooks by querying inside a .map.
interface RepoDiffReport {
  readonly fileCount: number;
  readonly isPending: boolean;
  readonly hasError: boolean;
}

interface WorkspaceCodeViewFile {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly fileKey: string;
  readonly collapsed: boolean;
}

function fileStatusLabel(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "A";
    case "deleted":
      return "D";
    case "rename-pure":
    case "rename-changed":
      return "R";
    default:
      return "M";
  }
}

// Runs the per-repo diff query, reports its file count up, and - only when this
// repo is the active drill-in target - renders either the file list or the
// selected file's diff. Kept as a per-worktree child so the query stays out of a
// parent .map (rules-of-hooks); mounted for every repo so counts stay live.
function WorkspaceRepoDiffSection(props: {
  environmentId: EnvironmentId;
  worktree: WorkspaceWorktree;
  composerDraftTarget: ScopedThreadRefOrDraft;
  ignoreWhitespace: boolean;
  isActive: boolean;
  selectedFileKey: string | null;
  onReport: (label: string, report: RepoDiffReport) => void;
  onSelectFile: (fileKey: string, filePath: string) => void;
}) {
  const {
    environmentId,
    worktree,
    composerDraftTarget,
    ignoreWhitespace,
    isActive,
    selectedFileKey,
    onReport,
    onSelectFile,
  } = props;
  const { resolvedTheme } = useTheme();

  const diffQuery = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId,
      input: {
        cwd: worktree.repoWorktreePath,
        ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      },
    }),
  );

  // The agent edits the worktree without committing, so its changes live in the
  // working tree. Prefer the working-tree source when it has content (mirrors
  // the single-repo DiffPanel default), and fall back to the branch-range source
  // (commits vs base) once work has been committed.
  const workingTreeSource = diffQuery.data?.sources.find(
    (candidate) => candidate.kind === "working-tree",
  );
  const branchRangeSource = diffQuery.data?.sources.find(
    (candidate) => candidate.kind === "branch-range",
  );
  const source =
    workingTreeSource && workingTreeSource.diff.trim().length > 0
      ? workingTreeSource
      : branchRangeSource && branchRangeSource.diff.trim().length > 0
        ? branchRangeSource
        : (workingTreeSource ?? branchRangeSource);
  const patch = source?.diff;

  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(patch, `workspace-diff:${worktree.label}:${resolvedTheme}`, {
        compactPartialHunkOffsets: true,
      }),
    [patch, resolvedTheme, worktree.label],
  );

  const codeViewFiles = useMemo<ReadonlyArray<WorkspaceCodeViewFile>>(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files
      .toSorted((left, right) =>
        resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .map((fileDiff) => ({
        fileDiff,
        // Qualify the comment path with the repo label so a "+" comment on
        // `workspace.md` reads `api/workspace.md L12` in the composer instead of
        // an ambiguous bare path shared across every member repo.
        filePath: `${worktree.label}/${resolveFileDiffPath(fileDiff)}`,
        fileKey: buildFileDiffRenderKey(fileDiff),
        collapsed: false,
      }));
  }, [renderablePatch, worktree.label]);

  const fileCount = codeViewFiles.length;
  const isPending = diffQuery.isPending && !renderablePatch;
  const hasError = Boolean(diffQuery.error) && !renderablePatch;

  useEffect(() => {
    onReport(worktree.label, { fileCount, isPending, hasError });
  }, [fileCount, hasError, isPending, onReport, worktree.label]);

  if (!isActive) {
    return null;
  }

  if (isPending) {
    return <DiffPanelLoadingState label={`Loading ${worktree.label} diff...`} />;
  }
  if (hasError) {
    return (
      <p className="px-3 py-3 text-[11px] text-red-500/80">
        {String(diffQuery.error).slice(0, 240)}
      </p>
    );
  }
  if (fileCount === 0) {
    return (
      <p className="px-3 py-6 text-center text-[11px] text-muted-foreground/55">
        No changes in this repo yet.
      </p>
    );
  }

  const selectedFile =
    selectedFileKey !== null
      ? codeViewFiles.find((file) => file.fileKey === selectedFileKey)
      : undefined;

  // File list: pick a file to open its diff.
  if (!selectedFile) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto py-1">
        {codeViewFiles.map((file) => (
          <button
            key={file.fileKey}
            type="button"
            onClick={() => onSelectFile(file.fileKey, resolveFileDiffPath(file.fileDiff))}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/60"
          >
            <FileDiffIcon
              className={cn("size-3.5 shrink-0", getDiffCollapseIconClassName(file.fileDiff))}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
              {resolveFileDiffPath(file.fileDiff)}
            </span>
            <span
              className={cn(
                "shrink-0 font-mono text-[10px]",
                getDiffCollapseIconClassName(file.fileDiff),
              )}
            >
              {fileStatusLabel(file.fileDiff)}
            </span>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
          </button>
        ))}
      </div>
    );
  }

  // Single-file diff.
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <AnnotatableCodeView
        className="diff-render-surface"
        files={[selectedFile]}
        sectionId={`workspace-repo:${worktree.label}`}
        sectionTitle={worktree.label}
        composerDraftTarget={composerDraftTarget}
        renderHeaderPrefix={() => null}
        options={{
          diffStyle: "unified",
          lineDiffType: "none",
          overflow: "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          themeType: resolvedTheme as DiffThemeType,
          unsafeCSS: DIFF_RENDER_UNSAFE_CSS,
          stickyHeaders: true,
          layout: { paddingTop: 8, paddingBottom: 8, gap: 8 },
        }}
      />
    </div>
  );
}

export default function WorkspaceDiffPanel({
  mode = "inline",
  composerDraftTarget,
}: WorkspaceDiffPanelProps) {
  const settings = useClientSettings();
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThread = useThread(routeThreadRef);
  const worktrees = activeThread?.worktrees ?? [];
  const orderedWorktrees = useMemo(
    () => [...worktrees].sort((left, right) => left.deployOrder - right.deployOrder),
    [worktrees],
  );

  const environmentId = activeThread?.environmentId ?? null;
  const activeThreadId = activeThread?.id ?? null;
  const [isShipping, setIsShipping] = useState(false);

  // Drill-in navigation: null repo => repo list; repo + null file => file list;
  // repo + file => that file's diff.
  const [selectedRepoLabel, setSelectedRepoLabel] = useState<string | null>(null);
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [reports, setReports] = useState<ReadonlyMap<string, RepoDiffReport>>(() => new Map());

  const handleReport = useCallback((label: string, report: RepoDiffReport) => {
    setReports((current) => {
      const existing = current.get(label);
      if (
        existing &&
        existing.fileCount === report.fileCount &&
        existing.isPending === report.isPending &&
        existing.hasError === report.hasError
      ) {
        return current;
      }
      const next = new Map(current);
      next.set(label, report);
      return next;
    });
  }, []);

  const selectRepo = useCallback((label: string) => {
    setSelectedRepoLabel(label);
    setSelectedFileKey(null);
    setSelectedFilePath(null);
  }, []);
  const backToRepos = useCallback(() => {
    setSelectedRepoLabel(null);
    setSelectedFileKey(null);
    setSelectedFilePath(null);
  }, []);
  const backToFiles = useCallback(() => {
    setSelectedFileKey(null);
    setSelectedFilePath(null);
  }, []);
  const selectFile = useCallback((fileKey: string, filePath: string) => {
    setSelectedFileKey(fileKey);
    setSelectedFilePath(filePath);
  }, []);

  // Fetch fresh per-cwd status imperatively (mounts+fetches) for the no-change
  // filter - a hook per worktree would violate the rules-of-hooks.
  const runStatusQuery = useAtomQueryRunner(vcsEnvironment.status);
  const threadToastData = useMemo(
    () => (routeThreadRef ? { threadRef: routeThreadRef } : undefined),
    [routeThreadRef],
  );

  // Ordered merge/deploy (M5): fold streamed per-repo progress into a badge per
  // repo section, and offer a merge-method menu on the header.
  const runMerge = useAtomCommand(workspaceMergeManager.mergeWorkspace, { reportFailure: false });
  const mergeState = useAtomValue(workspaceMergeManager.stateAtom(activeThreadId ?? "none"));
  const mergeStatusByLabel = useMemo(() => {
    const map = new Map<string, (typeof mergeState.repos)[number]["status"]>();
    for (const repo of mergeState.repos) {
      map.set(repo.label, repo.status);
    }
    return map;
  }, [mergeState.repos]);
  const mergeWorkspace = useCallback(
    (mergeMethod: WorkspaceMergeMethod) => {
      if (activeThreadId === null || environmentId === null || mergeState.isRunning) {
        return;
      }
      void runMerge({ environmentId, threadId: activeThreadId, mergeMethod, deleteBranch: true });
    },
    [activeThreadId, environmentId, mergeState.isRunning, runMerge],
  );

  // Ship one PR per CHANGED member repo on the shared branch. Each worktree is
  // already checked out on that branch (the bootstrap creates it there), so a
  // plain commit_push_pr targets it directly - no feature-branch step. Runs the
  // same keyed, serial-per-target vcsAction command per repo, in parallel across
  // repos. PR creation needs a real remote, so this is exercised by the pure
  // unit test here and manually QA'd against repos with GitHub remotes.
  const shipAllRepos = useCallback(async () => {
    if (environmentId === null || isShipping) {
      return;
    }
    if (resolveWorkspaceShipBranch(orderedWorktrees) === null) {
      return;
    }
    setIsShipping(true);
    try {
      const shippable: WorkspaceWorktree[] = [];
      for (const worktree of orderedWorktrees) {
        const statusResult = await runStatusQuery({
          environmentId,
          input: { cwd: worktree.repoWorktreePath },
        });
        if (statusResult._tag === "Success" && isWorktreeShippable(statusResult.value)) {
          shippable.push(worktree);
        }
      }
      if (shippable.length === 0) {
        toastManager.add({
          type: "info",
          title: "Nothing to ship",
          description: "No workspace repos have changes to open a pull request for.",
          ...(threadToastData ? { data: threadToastData } : {}),
        });
        return;
      }

      const entries = (
        await Promise.all(
          shippable.map(async (worktree): Promise<WorkspaceShipEntry | null> => {
            const toastId = toastManager.add({
              type: "loading",
              title: `Shipping ${worktree.label}...`,
              description: "Waiting for Git...",
              timeout: 0,
              ...(threadToastData ? { data: threadToastData } : {}),
            });
            const result = await runAtomCommand(
              appAtomRegistry,
              vcsActionManager.runStackedAction({
                environmentId,
                cwd: worktree.repoWorktreePath,
              }),
              { actionId: randomUUID(), action: "commit_push_pr" },
              { reportFailure: false },
            );
            if (result._tag === "Failure") {
              if (isAtomCommandInterrupted(result)) {
                toastManager.close(toastId);
                return null;
              }
              const error = squashAtomCommandFailure(result);
              const message = error instanceof Error ? error.message : "An error occurred.";
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "error",
                  title: `${worktree.label} failed`,
                  description: message,
                  ...(threadToastData ? { data: threadToastData } : {}),
                }),
              );
              return { label: worktree.label, prUrl: null, error: message };
            }
            const prUrl = resolveShipPrUrl(result.value);
            toastManager.update(
              toastId,
              stackedThreadToast({
                type: "success",
                title: result.value.toast.title,
                ...(result.value.toast.description
                  ? { description: result.value.toast.description }
                  : {}),
                timeout: 0,
                ...(prUrl
                  ? {
                      actionProps: {
                        children: "Open PR",
                        onClick: () => {
                          const api = readLocalApi();
                          if (api) {
                            void openPullRequestLink(api.shell, prUrl);
                          }
                        },
                      },
                    }
                  : {}),
                ...(threadToastData
                  ? { data: { ...threadToastData, dismissAfterVisibleMs: 10_000 } }
                  : {}),
              }),
            );
            return { label: worktree.label, prUrl, error: null };
          }),
        )
      ).filter((entry): entry is WorkspaceShipEntry => entry !== null);

      if (entries.length === 0) {
        return;
      }
      const summary = summarizeWorkspaceShip(entries);
      toastManager.add({
        type: summary.failed > 0 ? "warning" : "success",
        title:
          summary.failed > 0
            ? `Shipped ${summary.shipped} of ${entries.length} repos`
            : `Shipped ${summary.shipped} repo${summary.shipped === 1 ? "" : "s"}`,
        ...(threadToastData ? { data: threadToastData } : {}),
      });
    } finally {
      setIsShipping(false);
    }
  }, [environmentId, isShipping, orderedWorktrees, runStatusQuery, threadToastData]);

  const activeWorktree =
    selectedRepoLabel !== null
      ? orderedWorktrees.find((worktree) => worktree.label === selectedRepoLabel)
      : undefined;

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <BoxesIcon className="size-4 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-sm font-medium text-foreground">Workspace changes</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          {orderedWorktrees.length} {orderedWorktrees.length === 1 ? "repo" : "repos"}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Button
          variant="outline"
          size="xs"
          disabled={isShipping || orderedWorktrees.length === 0}
          onClick={() => void shipAllRepos()}
        >
          <UploadCloudIcon className="size-3.5" aria-hidden />
          <span className="ml-0.5">{isShipping ? "Shipping..." : "Ship all repos"}</span>
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="xs"
                disabled={orderedWorktrees.length === 0 || mergeState.isRunning}
              />
            }
          >
            <GitMergeIcon className="size-3.5" aria-hidden />
            <span className="ml-0.5">
              {mergeState.isRunning ? "Merging..." : "Merge workspace"}
            </span>
          </MenuTrigger>
          <MenuPopup align="end" className="w-52">
            <MenuItem onClick={() => mergeWorkspace("squash")}>Squash merge each PR</MenuItem>
            <MenuItem onClick={() => mergeWorkspace("merge")}>Merge commit each PR</MenuItem>
            <MenuItem onClick={() => mergeWorkspace("rebase")}>Rebase merge each PR</MenuItem>
          </MenuPopup>
        </Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="outline"
                size="xs"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => setDiffIgnoreWhitespace(Boolean(pressed))}
              />
            }
          >
            <PilcrowIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={header}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect workspace diffs.
        </div>
      ) : orderedWorktrees.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          This workspace thread has no member worktrees yet.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Breadcrumb shown once drilled into a repo. */}
          {activeWorktree ? (
            <div className="surface-subheader sticky top-0 z-20 flex items-center gap-1 px-2 py-1.5 text-[11px]">
              <button
                type="button"
                onClick={backToRepos}
                className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              >
                <ChevronLeftIcon className="size-3" />
                Repos
              </button>
              <span className="text-muted-foreground/30">/</span>
              <button
                type="button"
                onClick={backToFiles}
                className={cn(
                  "truncate rounded px-1 py-0.5 font-medium",
                  selectedFilePath
                    ? "text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                    : "text-foreground",
                )}
              >
                {activeWorktree.label}
              </button>
              {selectedFilePath ? (
                <>
                  <span className="text-muted-foreground/30">/</span>
                  <span className="truncate font-mono text-foreground/90">{selectedFilePath}</span>
                </>
              ) : null}
            </div>
          ) : (
            // Repo list: one row per member repo. Counts fill in from `reports`
            // once a repo has been opened (diffs load lazily, one repo at a time,
            // so eight concurrent git diffs never race and drop to a false "No
            // changes").
            <div className="flex min-h-0 flex-1 flex-col overflow-auto py-1">
              {orderedWorktrees.map((worktree) => {
                const report = reports.get(worktree.label);
                const status = mergeStatusByLabel.get(worktree.label);
                const countLabel = !report
                  ? "Open"
                  : report.isPending
                    ? "…"
                    : report.hasError
                      ? "error"
                      : report.fileCount === 0
                        ? "No changes"
                        : `${report.fileCount} ${report.fileCount === 1 ? "file" : "files"}`;
                const isChanged = report !== undefined && !report.isPending && report.fileCount > 0;
                return (
                  <button
                    key={worktree.repoWorktreePath}
                    type="button"
                    onClick={() => selectRepo(worktree.label)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/60"
                  >
                    <BoxesIcon
                      className={cn(
                        "size-3.5 shrink-0",
                        isChanged ? "text-foreground/80" : "text-muted-foreground/50",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          "truncate text-xs font-medium",
                          isChanged ? "text-foreground/90" : "text-muted-foreground/70",
                        )}
                      >
                        {worktree.label}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground/50">
                        {worktree.branch}
                      </span>
                    </span>
                    {status ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                          status === "failed"
                            ? "bg-destructive/15 text-destructive"
                            : status === "merged" || status === "deployed"
                              ? "bg-success/15 text-success"
                              : "bg-accent/60 text-muted-foreground",
                        )}
                      >
                        {MERGE_STATUS_LABEL[status] ?? status}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "shrink-0 text-[10px]",
                        isChanged ? "text-foreground/70" : "text-muted-foreground/45",
                      )}
                    >
                      {countLabel}
                    </span>
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
                  </button>
                );
              })}
            </div>
          )}

          {/* Only the drilled-in repo mounts (and queries), so diffs load one
              repo at a time - no eight-way concurrent git-diff race. */}
          {activeWorktree ? (
            <WorkspaceRepoDiffSection
              key={activeWorktree.repoWorktreePath}
              environmentId={activeThread.environmentId}
              worktree={activeWorktree}
              composerDraftTarget={composerDraftTarget}
              ignoreWhitespace={diffIgnoreWhitespace}
              isActive
              selectedFileKey={selectedFileKey}
              onReport={handleReport}
              onSelectFile={selectFile}
            />
          ) : null}
        </div>
      )}
    </DiffPanelShell>
  );
}
