import { createEnvironmentWorkspaceAtoms } from "@t3tools/client-runtime/state/workspaces";
import { createWorkspaceEnvironmentAtoms } from "@t3tools/client-runtime/state/workspaces";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const workspaceEnvironment = createWorkspaceEnvironmentAtoms(connectionAtomRuntime);
export const environmentWorkspaces = createEnvironmentWorkspaceAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
