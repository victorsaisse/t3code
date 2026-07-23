/**
 * ProjectionWorkspaceRepository - Projection repository interface for workspaces.
 *
 * Owns persistence operations for workspace rows in the orchestration projection
 * read model. Mirrors ProjectionProjectRepository.
 *
 * @module ProjectionWorkspaceRepository
 */
import { IsoDateTime, ModelSelection, WorkspaceId, WorkspaceMember } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  title: Schema.String,
  members: Schema.Array(WorkspaceMember),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionWorkspace = typeof ProjectionWorkspace.Type;

export const GetProjectionWorkspaceInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type GetProjectionWorkspaceInput = typeof GetProjectionWorkspaceInput.Type;

export const DeleteProjectionWorkspaceInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type DeleteProjectionWorkspaceInput = typeof DeleteProjectionWorkspaceInput.Type;

/**
 * ProjectionWorkspaceRepositoryShape - Service API for projected workspace records.
 */
export interface ProjectionWorkspaceRepositoryShape {
  /**
   * Insert or replace a projected workspace row.
   *
   * Upserts by `workspaceId` and persists members through JSON encoding.
   */
  readonly upsert: (row: ProjectionWorkspace) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected workspace row by id.
   */
  readonly getById: (
    input: GetProjectionWorkspaceInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkspace>, ProjectionRepositoryError>;

  /**
   * List all projected workspace rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionWorkspace>,
    ProjectionRepositoryError
  >;

  /**
   * Hard-delete a projected workspace row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionWorkspaceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionWorkspaceRepository - Service tag for workspace projection persistence.
 */
export class ProjectionWorkspaceRepository extends Context.Service<
  ProjectionWorkspaceRepository,
  ProjectionWorkspaceRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspaces/ProjectionWorkspaceRepository") {}
