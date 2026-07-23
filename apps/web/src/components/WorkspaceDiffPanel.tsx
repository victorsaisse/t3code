import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import type {
  EnvironmentId,
  ScopedThreadRef,
  VcsStatusResult,
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
  GitPullRequestIcon,
  PilcrowIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import {
  buildFileDiffRenderKey,
  computeFileDiffStats,
  DIFF_RENDER_UNSAFE_CSS,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  sumFileDiffStats,
  type DiffLineStat,
} from "../lib/diffRendering";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import { resolveWorkspaceShipBranch } from "../lib/workspaceShip";
import { readLocalApi } from "../localApi";
import { cn } from "~/lib/utils";
import { useThread } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment, workspaceMergeManager } from "../state/vcs";
import { resolveThreadRouteRef } from "../threadRoutes";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";
import { Toggle } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type DiffThemeType = "light" | "dark";

type ScopedThreadRefOrDraft = ScopedThreadRef | DraftId;
type RepoPr = VcsStatusResult["pr"];

interface WorkspaceDiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRefOrDraft;
}

/**
 * A drill-in navigator for all workspace member repos. Each repo has its own git
 * worktree (`repoWorktreePath`), so the single-repo DiffPanel - which reads one
 * `cwd` - can only ever show one of them. This panel keeps a live per-repo status
 * subscription for the repo list (change stats + PR/merge state, all repos at
 * once), then lazily loads the full diff only for the repo you open: repo list ->
 * that repo's changed files (with +/-) -> the file's code diff.
 */
const MERGE_STATUS_LABEL: Record<string, string> = {
  pending: "Merging…",
  merged: "Merged",
  deploying: "Deploying…",
  deployed: "Deployed",
  skipped: "Skipped",
  failed: "Failed",
};

// Live per-repo summary from the status subscription, powering the repo list
// (stats + PR) for every member at once - cheap vs. fanning out a full diff per
// repo, which raced and dropped to false "No changes" at 8 repos.
interface RepoStatusReport {
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  readonly aheadCount: number;
  readonly hasChanges: boolean;
  readonly pr: RepoPr;
}

interface WorkspaceCodeViewFile {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly fileKey: string;
  readonly collapsed: boolean;
  readonly stat: DiffLineStat;
}

// One live status subscription per member repo. Renders nothing; it exists only
// to keep `onReport` fed so the parent repo list shows every repo's stats + PR
// without querying inside a .map (rules-of-hooks).
function WorkspaceRepoStatusProbe(props: {
  environmentId: EnvironmentId;
  worktree: WorkspaceWorktree;
  onReport: (label: string, report: RepoStatusReport) => void;
}) {
  const { environmentId, worktree, onReport } = props;
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: worktree.repoWorktreePath } }),
  );
  const status = statusQuery.data;
  const changedFiles = status?.workingTree.files.length ?? 0;
  const additions = status?.workingTree.insertions ?? 0;
  const deletions = status?.workingTree.deletions ?? 0;
  const aheadCount = status?.aheadCount ?? 0;
  const hasChanges = Boolean(status?.hasWorkingTreeChanges) || aheadCount > 0;
  const pr = status?.pr ?? null;

  useEffect(() => {
    if (!status) return;
    onReport(worktree.label, { changedFiles, additions, deletions, aheadCount, hasChanges, pr });
  }, [
    additions,
    aheadCount,
    changedFiles,
    deletions,
    hasChanges,
    onReport,
    pr,
    status,
    worktree.label,
  ]);
  return null;
}

// Loads the full diff for the ACTIVE repo only, and renders its file list (with
// per-file +/-) or the selected file's code diff. Lazy => one repo's diff at a
// time, no eight-way concurrent git-diff race.
function WorkspaceRepoDiffSection(props: {
  environmentId: EnvironmentId;
  worktree: WorkspaceWorktree;
  composerDraftTarget: ScopedThreadRefOrDraft;
  ignoreWhitespace: boolean;
  selectedFileKey: string | null;
  onSelectFile: (fileKey: string, filePath: string) => void;
}) {
  const {
    environmentId,
    worktree,
    composerDraftTarget,
    ignoreWhitespace,
    selectedFileKey,
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
  // working tree. Prefer the working-tree source when it has content, falling
  // back to the branch-range source (commits vs base) once work is committed.
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
        stat: computeFileDiffStats(fileDiff),
      }));
  }, [renderablePatch, worktree.label]);

  const fileCount = codeViewFiles.length;

  if (diffQuery.isPending && !renderablePatch) {
    return <DiffPanelLoadingState label={`Loading ${worktree.label} diff...`} />;
  }
  if (diffQuery.error && !renderablePatch) {
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
            {hasNonZeroStat(file.stat) ? (
              <DiffStatLabel
                additions={file.stat.additions}
                deletions={file.stat.deletions}
                layout="inline"
                className="shrink-0 text-[10px]"
              />
            ) : null}
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

function RepoPrPill(props: { pr: RepoPr }) {
  const { pr } = props;
  if (!pr) {
    return <span className="shrink-0 text-[10px] text-muted-foreground/45">No PR</span>;
  }
  const openPr = () => {
    const api = readLocalApi();
    if (api) void openPullRequestLink(api.shell, pr.url);
  };
  const tone =
    pr.state === "merged"
      ? "bg-success/15 text-success"
      : pr.state === "closed"
        ? "bg-muted text-muted-foreground"
        : "bg-accent/70 text-foreground/80";
  const label =
    pr.state === "merged" ? "Merged" : pr.state === "closed" ? "Closed" : `PR #${pr.number}`;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        openPr();
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium hover:opacity-80",
        tone,
      )}
    >
      <GitPullRequestIcon className="size-2.5" aria-hidden />
      {label}
    </button>
  );
}

export default function WorkspaceDiffPanel({
  mode = "inline",
  composerDraftTarget,
}: WorkspaceDiffPanelProps) {
  const settings = useClientSettings();
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const setComposerPrompt = useComposerDraftStore((store) => store.setPrompt);

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

  // Drill-in navigation: null repo => repo list; repo + null file => file list;
  // repo + file => that file's diff.
  const [selectedRepoLabel, setSelectedRepoLabel] = useState<string | null>(null);
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [statusReports, setStatusReports] = useState<ReadonlyMap<string, RepoStatusReport>>(
    () => new Map(),
  );

  const handleStatusReport = useCallback((label: string, report: RepoStatusReport) => {
    setStatusReports((current) => {
      const existing = current.get(label);
      if (
        existing &&
        existing.changedFiles === report.changedFiles &&
        existing.additions === report.additions &&
        existing.deletions === report.deletions &&
        existing.aheadCount === report.aheadCount &&
        existing.hasChanges === report.hasChanges &&
        (existing.pr?.number ?? null) === (report.pr?.number ?? null) &&
        (existing.pr?.state ?? null) === (report.pr?.state ?? null)
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

  // Ordered merge/deploy (M5): fold streamed per-repo progress into a badge per
  // repo, and offer a merge-method menu on the header.
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

  // "Create PR(s)" no longer runs git itself (that failed silently with no
  // feedback). Instead it drops a plain instruction into the composer so the
  // agent opens the PRs with its own tools - reviewable, editable, and the same
  // thing the user could just type. It targets the repos that currently have
  // changes, falling back to all members if status hasn't loaded yet.
  const createPrInstruction = useCallback(() => {
    const branch = resolveWorkspaceShipBranch(orderedWorktrees);
    const changed = orderedWorktrees.filter((worktree) => {
      const report = statusReports.get(worktree.label);
      return report ? report.hasChanges : true;
    });
    const targets = changed.length > 0 ? changed : orderedWorktrees;
    if (targets.length === 0) return;
    const labels = targets.map((worktree) => worktree.label).join(", ");
    const branchClause = branch ? ` They share the branch \`${branch}\`.` : "";
    const text =
      `Open a pull request for each of these workspace repos that has changes: ${labels}.` +
      `${branchClause} Create one PR per repo (commit and push first if needed). ` +
      `If a proper deploy order matters, do them in that order and tell me.`;
    setComposerPrompt(composerDraftTarget, text);
    toastManager.add({
      type: "info",
      title: "Added to chat",
      description: "Review the PR instruction in the composer and send it.",
    });
  }, [composerDraftTarget, orderedWorktrees, setComposerPrompt, statusReports]);

  const activeWorktree =
    selectedRepoLabel !== null
      ? orderedWorktrees.find((worktree) => worktree.label === selectedRepoLabel)
      : undefined;

  const header = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <BoxesIcon className="size-4 shrink-0 text-muted-foreground/70" />
        <span className="shrink-0 text-sm font-medium text-foreground">Changes</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          {orderedWorktrees.length} {orderedWorktrees.length === 1 ? "repo" : "repos"}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Button
          variant="outline"
          size="xs"
          disabled={orderedWorktrees.length === 0}
          onClick={createPrInstruction}
        >
          <GitPullRequestIcon className="size-3.5" aria-hidden />
          <span className="ml-0.5">Create PR(s)</span>
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
            <span className="ml-0.5">{mergeState.isRunning ? "Merging..." : "Merge"}</span>
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
          {/* Live per-repo status probes (render nothing). */}
          {environmentId !== null
            ? orderedWorktrees.map((worktree) => (
                <WorkspaceRepoStatusProbe
                  key={`status:${worktree.repoWorktreePath}`}
                  environmentId={environmentId}
                  worktree={worktree}
                  onReport={handleStatusReport}
                />
              ))
            : null}

          {activeWorktree ? (
            <>
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
                    <span className="truncate font-mono text-foreground/90">
                      {selectedFilePath}
                    </span>
                  </>
                ) : null}
              </div>
              <WorkspaceRepoDiffSection
                key={activeWorktree.repoWorktreePath}
                environmentId={activeThread.environmentId}
                worktree={activeWorktree}
                composerDraftTarget={composerDraftTarget}
                ignoreWhitespace={diffIgnoreWhitespace}
                selectedFileKey={selectedFileKey}
                onSelectFile={selectFile}
              />
            </>
          ) : (
            // Repo list: every member with its live change stats + PR/merge state.
            <div className="flex min-h-0 flex-1 flex-col overflow-auto py-1">
              {orderedWorktrees.map((worktree) => {
                const report = statusReports.get(worktree.label);
                const mergeStatus = mergeStatusByLabel.get(worktree.label);
                const isChanged = report?.hasChanges ?? false;
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
                    {report && hasNonZeroStat(report) ? (
                      <DiffStatLabel
                        additions={report.additions}
                        deletions={report.deletions}
                        layout="inline"
                        className="shrink-0 text-[10px]"
                      />
                    ) : null}
                    {report ? <RepoPrPill pr={report.pr} /> : null}
                    {mergeStatus ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                          mergeStatus === "failed"
                            ? "bg-destructive/15 text-destructive"
                            : mergeStatus === "merged" || mergeStatus === "deployed"
                              ? "bg-success/15 text-success"
                              : "bg-accent/60 text-muted-foreground",
                        )}
                      >
                        {MERGE_STATUS_LABEL[mergeStatus] ?? mergeStatus}
                      </span>
                    ) : null}
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </DiffPanelShell>
  );
}
