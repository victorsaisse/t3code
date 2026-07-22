import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationWorkspaceShell,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentWorkspace } from "./models.ts";
import { scopeWorkspace } from "./models.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { arrayElementsEqual } from "./entities.ts";

const EMPTY_WORKSPACES: ReadonlyArray<OrchestrationWorkspaceShell> = Object.freeze([]);

/**
 * Workspace read atoms, mirroring `createEnvironmentProjectAtoms` but for the
 * Workspace aggregate. Workspaces are surfaced above Projects in the sidebar.
 */
export function createEnvironmentWorkspaceAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentWorkspacesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationWorkspaceShell> =>
        get(input.snapshotAtom(environmentId))?.workspaces ?? EMPTY_WORKSPACES,
    ).pipe(Atom.withLabel(`environment-workspaces:${environmentId}`)),
  );

  const environmentScopedWorkspacesAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<EnvironmentWorkspace> = [];
    return Atom.make((get): ReadonlyArray<EnvironmentWorkspace> => {
      const next = get(environmentWorkspacesAtom(environmentId)).map((workspace) =>
        scopeWorkspace(environmentId, workspace),
      );
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-scoped-workspaces:${environmentId}`));
  });

  let previousWorkspaces: ReadonlyArray<EnvironmentWorkspace> = [];
  const workspacesAtom = Atom.make((get): ReadonlyArray<EnvironmentWorkspace> => {
    const next: EnvironmentWorkspace[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      next.push(...get(environmentScopedWorkspacesAtom(environmentId)));
    }
    if (arrayElementsEqual(previousWorkspaces, next)) {
      return previousWorkspaces;
    }
    previousWorkspaces = next;
    return next;
  }).pipe(Atom.withLabel("environment-workspace-list"));

  return {
    environmentWorkspacesAtom,
    environmentScopedWorkspacesAtom,
    workspacesAtom,
  };
}
