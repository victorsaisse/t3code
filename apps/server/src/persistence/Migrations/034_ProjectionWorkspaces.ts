import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspaces (
      workspace_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      members_json TEXT NOT NULL,
      default_model_selection_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspaces_updated_at
    ON projection_workspaces(updated_at)
  `;
});
