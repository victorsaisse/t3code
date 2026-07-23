import { expect, it } from "@effect/vitest";
import {
  GitCommandError,
  ProjectId,
  type ThreadTurnStartBootstrapWorkspaceRepo,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { provisionWorkspaceWorktrees } from "./workspaceProvisioning.ts";

function repo(
  overrides: Partial<ThreadTurnStartBootstrapWorkspaceRepo> & { readonly label: string },
): ThreadTurnStartBootstrapWorkspaceRepo {
  return {
    projectId: ProjectId.make(`project-${overrides.label}`),
    projectCwd: `/repos/${overrides.label}`,
    baseBranch: null,
    deployOrder: 0,
    ...overrides,
  } as ThreadTurnStartBootstrapWorkspaceRepo;
}

const baseDeps = {
  fetchRemote: () => Effect.void,
  resolveRemoteTrackingCommit: () =>
    Effect.succeed({ commitSha: "sha", remoteRefName: "origin/main" }),
  refreshGitStatus: () => Effect.void,
};

it.effect("skips an empty/failing repo and still provisions the rest", () =>
  Effect.gen(function* () {
    const skipped: string[] = [];
    const result = yield* provisionWorkspaceWorktrees({
      workspaceThreadRoot: "/ws/thread-1",
      branch: "t3code/x",
      repos: [
        repo({ label: "api", deployOrder: 0 }),
        repo({ label: "empty", deployOrder: 1 }),
        repo({ label: "web", deployOrder: 2 }),
      ],
      deps: {
        ...baseDeps,
        createWorktree: (input) =>
          input.cwd === "/repos/empty"
            ? Effect.fail(
                new GitCommandError({
                  operation: "createWorktree",
                  command: "git",
                  cwd: input.cwd,
                  detail: "invalid reference: HEAD",
                }),
              )
            : Effect.succeed({ worktree: { path: input.path, refName: input.newRefName } }),
        onRepoSkipped: (skip) => Effect.sync(() => skipped.push(skip.label)),
      },
    });
    expect(result.map((worktree) => worktree.label)).toStrictEqual(["api", "web"]);
    expect(skipped).toStrictEqual(["empty"]);
  }),
);

it.effect("skips a member whose label is too long without calling createWorktree", () =>
  Effect.gen(function* () {
    const skipped: { label: string; issue?: string }[] = [];
    let createCalls = 0;
    const result = yield* provisionWorkspaceWorktrees({
      workspaceThreadRoot: "/ws/thread-1",
      branch: "t3code/x",
      repos: [repo({ label: "x".repeat(40) })],
      deps: {
        ...baseDeps,
        createWorktree: (input) => {
          createCalls += 1;
          return Effect.succeed({ worktree: { path: input.path, refName: input.newRefName } });
        },
        onRepoSkipped: (skip) =>
          Effect.sync(() =>
            skipped.push({ label: skip.label, ...(skip.issue ? { issue: skip.issue } : {}) }),
          ),
      },
    });
    expect(result).toStrictEqual([]);
    expect(skipped[0]?.issue).toBe("label-too-long");
    expect(createCalls).toBe(0);
  }),
);
