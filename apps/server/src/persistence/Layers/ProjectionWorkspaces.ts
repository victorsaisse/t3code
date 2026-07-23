import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ModelSelection, WorkspaceMember } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionWorkspaceInput,
  GetProjectionWorkspaceInput,
  ProjectionWorkspace,
  ProjectionWorkspaceRepository,
  type ProjectionWorkspaceRepositoryShape,
} from "../Services/ProjectionWorkspaces.ts";

const ProjectionWorkspaceDbRow = ProjectionWorkspace.mapFields(
  Struct.assign({
    members: Schema.fromJsonString(Schema.Array(WorkspaceMember)),
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  }),
);
type ProjectionWorkspaceDbRow = typeof ProjectionWorkspaceDbRow.Type;

const makeProjectionWorkspaceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkspaceRow = SqlSchema.void({
    Request: ProjectionWorkspace,
    execute: (row) =>
      sql`
        INSERT INTO projection_workspaces (
          workspace_id,
          title,
          members_json,
          default_model_selection_json,
          created_at,
          updated_at,
          deleted_at,
          archived_at
        )
        VALUES (
          ${row.workspaceId},
          ${row.title},
          ${JSON.stringify(row.members)},
          ${row.defaultModelSelection !== null ? JSON.stringify(row.defaultModelSelection) : null},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt},
          ${row.archivedAt}
        )
        ON CONFLICT (workspace_id)
        DO UPDATE SET
          title = excluded.title,
          members_json = excluded.members_json,
          default_model_selection_json = excluded.default_model_selection_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          archived_at = excluded.archived_at
      `,
  });

  const getProjectionWorkspaceRow = SqlSchema.findOneOption({
    Request: GetProjectionWorkspaceInput,
    Result: ProjectionWorkspaceDbRow,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          title,
          members_json AS "members",
          default_model_selection_json AS "defaultModelSelection",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt",
          archived_at AS "archivedAt"
        FROM projection_workspaces
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const listProjectionWorkspaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkspaceDbRow,
    execute: () =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          title,
          members_json AS "members",
          default_model_selection_json AS "defaultModelSelection",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt",
          archived_at AS "archivedAt"
        FROM projection_workspaces
        ORDER BY created_at ASC, workspace_id ASC
      `,
  });

  const deleteProjectionWorkspaceRow = SqlSchema.void({
    Request: DeleteProjectionWorkspaceInput,
    execute: ({ workspaceId }) =>
      sql`
        DELETE FROM projection_workspaces
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const upsert: ProjectionWorkspaceRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkspaceRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.upsert:query")),
    );

  const getById: ProjectionWorkspaceRepositoryShape["getById"] = (input) =>
    getProjectionWorkspaceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.getById:query")),
    );

  const listAll: ProjectionWorkspaceRepositoryShape["listAll"] = () =>
    listProjectionWorkspaceRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.listAll:query")),
    );

  const deleteById: ProjectionWorkspaceRepositoryShape["deleteById"] = (input) =>
    deleteProjectionWorkspaceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionWorkspaceRepositoryShape;
});

export const ProjectionWorkspaceRepositoryLive = Layer.effect(
  ProjectionWorkspaceRepository,
  makeProjectionWorkspaceRepository,
);
