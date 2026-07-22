import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "workspace_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workspace_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "workspace_root")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workspace_root TEXT
    `;
  }

  if (!columns.some((column) => column.name === "worktrees_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN worktrees_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
