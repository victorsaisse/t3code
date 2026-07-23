import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type CreateWorkspaceInput,
  type DeleteWorkspaceInput,
  type UpdateWorkspaceInput,
  createWorkspace,
  deleteWorkspace,
  updateWorkspace,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateWorkspaceInput,
  DeleteWorkspaceInput,
  UpdateWorkspaceInput,
} from "../operations/commands.ts";

/**
 * Atom command factory for the Workspace aggregate, mirroring
 * `createProjectEnvironmentAtoms`. Commands are serialized per workspace id.
 */
export function createWorkspaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const workspaceScheduler = createAtomCommandScheduler();
  const workspaceConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { workspaceId: string } }) =>
      JSON.stringify([environmentId, input.workspaceId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:workspace:create",
      execute: (input: CreateWorkspaceInput) => createWorkspace(input),
      scheduler: workspaceScheduler,
      concurrency: workspaceConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:workspace:update",
      execute: (input: UpdateWorkspaceInput) => updateWorkspace(input),
      scheduler: workspaceScheduler,
      concurrency: workspaceConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:workspace:delete",
      execute: (input: DeleteWorkspaceInput) => deleteWorkspace(input),
      scheduler: workspaceScheduler,
      concurrency: workspaceConcurrency,
    }),
  };
}
