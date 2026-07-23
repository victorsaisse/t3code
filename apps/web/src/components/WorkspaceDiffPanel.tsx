import { useParams } from "@tanstack/react-router";
import type { EnvironmentId, ScopedThreadRef, WorkspaceWorktree } from "@t3tools/contracts";
import { BoxesIcon, PilcrowIcon } from "lucide-react";
import { useMemo, useState } from "react";

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
import { cn } from "~/lib/utils";
import { useThread } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { reviewEnvironment } from "../state/review";
import { resolveThreadRouteRef } from "../threadRoutes";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
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
