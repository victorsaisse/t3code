import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, WorkspaceWorktree } from "@t3tools/contracts";
import { BoxesIcon, PilcrowIcon, UploadCloudIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { type DraftId } from "../composerDraftStore";
import { useTheme } from "../hooks/useTheme";
import { useClientSettings } from "../hooks/useSettings";
import {
  buildFileDiffRenderKey,
  DIFF_RENDER_UNSAFE_CSS,
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
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { reviewEnvironment } from "../state/review";
import { vcsActionManager, vcsEnvironment } from "../state/vcs";
import { resolveThreadRouteRef } from "../threadRoutes";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
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
 * One diff section per workspace member repo. Each repo has its own git
 * worktree (`repoWorktreePath`), so the single-repo DiffPanel - which reads
 * one `cwd` - can only ever show one of them (and would run git on the
 * non-git shared root). This panel fans out one `diffPreview` query per
 * worktree and stacks the results, giving "all workspace changes, separated
 * by repo, all in one place".
 */
function WorkspaceRepoDiffSection(props: {
  environmentId: EnvironmentId;
  worktree: WorkspaceWorktree;
  composerDraftTarget: ScopedThreadRefOrDraft;
  ignoreWhitespace: boolean;
}) {
  const { environmentId, worktree, composerDraftTarget, ignoreWhitespace } = props;
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

  const codeViewFiles = useMemo(() => {
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
        filePath: resolveFileDiffPath(fileDiff),
        fileKey: buildFileDiffRenderKey(fileDiff),
        collapsed: false,
      }));
  }, [renderablePatch]);

  const fileCount = codeViewFiles.length;

  return (
    <section className="flex shrink-0 flex-col border-b border-border/60">
      <header className="surface-subheader sticky top-0 z-20 flex items-center gap-2 px-3 py-1.5">
        <BoxesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate text-xs font-medium text-foreground/90">{worktree.label}</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground/55">
          {worktree.branch}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
          {fileCount === 0 ? "No changes" : `${fileCount} ${fileCount === 1 ? "file" : "files"}`}
        </span>
      </header>
      {diffQuery.isPending && !renderablePatch ? (
        <DiffPanelLoadingState label={`Loading ${worktree.label} diff...`} />
      ) : diffQuery.error && !renderablePatch ? (
        <p className="px-3 py-2 text-[11px] text-red-500/80">
          {String(diffQuery.error).slice(0, 240)}
        </p>
      ) : fileCount === 0 ? (
        <p className="px-3 py-3 text-[11px] text-muted-foreground/55">
          No changes in this repo yet.
        </p>
      ) : (
        <div className="max-h-[70vh] min-h-0 overflow-auto">
          <AnnotatableCodeView
            className="diff-render-surface"
            files={codeViewFiles}
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
      )}
    </section>
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
  const [isShipping, setIsShipping] = useState(false);
  // Fetch fresh per-cwd status imperatively (mounts+fetches) for the no-change
  // filter - a hook per worktree would violate the rules-of-hooks.
  const runStatusQuery = useAtomQueryRunner(vcsEnvironment.status);
  const threadToastData = useMemo(
    () => (routeThreadRef ? { threadRef: routeThreadRef } : undefined),
    [routeThreadRef],
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
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-auto")}>
          {orderedWorktrees.map((worktree) => (
            <WorkspaceRepoDiffSection
              key={worktree.repoWorktreePath}
              environmentId={activeThread.environmentId}
              worktree={worktree}
              composerDraftTarget={composerDraftTarget}
              ignoreWhitespace={diffIgnoreWhitespace}
            />
          ))}
        </div>
      )}
    </DiffPanelShell>
  );
}
