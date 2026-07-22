import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  WorkspaceId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asWorkspaceId = (value: string): WorkspaceId => WorkspaceId.make(value);

const now = "2026-01-01T00:00:00.000Z";

const members = [
  { projectId: asProjectId("project-web"), label: "web", baseBranch: null, deployOrder: 0 },
  { projectId: asProjectId("project-mobile"), label: "mobile", baseBranch: "main", deployOrder: 1 },
];

const createCommand: OrchestrationCommand = {
  type: "workspace.create",
  commandId: asCommandId("cmd-workspace-create"),
  workspaceId: asWorkspaceId("workspace-frontend"),
  title: "Frontend",
  members,
  createdAt: now,
};

const seedWithWorkspace = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  return yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-workspace-create"),
    aggregateKind: "workspace",
    aggregateId: asWorkspaceId("workspace-frontend"),
    type: "workspace.created",
    occurredAt: now,
    commandId: asCommandId("cmd-workspace-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-workspace-create"),
    metadata: {},
    payload: {
      workspaceId: asWorkspaceId("workspace-frontend"),
      title: "Frontend",
      members,
      defaultModelSelection: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("workspace decider", (it) => {
  it.effect("workspace.create emits workspace.created with members", () =>
    Effect.gen(function* () {
      const readModel = createEmptyReadModel(now);
      const decided = yield* decideOrchestrationCommand({ command: createCommand, readModel });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event.type).toBe("workspace.created");
      expect(event.aggregateKind).toBe("workspace");
      if (event.type === "workspace.created") {
        expect(event.payload.workspaceId).toBe("workspace-frontend");
        expect(event.payload.members.map((m: { label: string }) => m.label)).toEqual([
          "web",
          "mobile",
        ]);
        expect(event.payload.defaultModelSelection).toBeNull();
      }
    }),
  );

  it.effect("workspace.create rejects duplicate member labels", () =>
    Effect.gen(function* () {
      const readModel = createEmptyReadModel(now);
      const command: OrchestrationCommand = {
        type: "workspace.create",
        commandId: asCommandId("cmd-workspace-dupe"),
        workspaceId: asWorkspaceId("workspace-dupe"),
        title: "Dupe",
        members: [
          { projectId: asProjectId("project-a"), label: "app", baseBranch: null, deployOrder: 0 },
          { projectId: asProjectId("project-b"), label: "app", baseBranch: null, deployOrder: 1 },
        ],
        createdAt: now,
      };
      const error = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("used more than once");
      }
    }),
  );

  it.effect("workspace.create rejects creating the same workspace twice", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithWorkspace;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: createCommand, readModel }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("already exists");
      }
    }),
  );

  it.effect("workspace.meta.update on a missing workspace fails", () =>
    Effect.gen(function* () {
      const readModel = createEmptyReadModel(now);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "workspace.meta.update",
            commandId: asCommandId("cmd-workspace-update"),
            workspaceId: asWorkspaceId("workspace-missing"),
            title: "Renamed",
          },
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("does not exist");
      }
    }),
  );

  it.effect("workspace.meta.update emits a partial meta-updated event", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithWorkspace;
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "workspace.meta.update",
          commandId: asCommandId("cmd-workspace-update"),
          workspaceId: asWorkspaceId("workspace-frontend"),
          title: "Frontend Renamed",
        },
        readModel,
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event.type).toBe("workspace.meta-updated");
      if (event.type === "workspace.meta-updated") {
        expect(event.payload.title).toBe("Frontend Renamed");
        expect(event.payload.members).toBeUndefined();
      }
    }),
  );

  it.effect("workspace.delete emits workspace.deleted", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithWorkspace;
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "workspace.delete",
          commandId: asCommandId("cmd-workspace-delete"),
          workspaceId: asWorkspaceId("workspace-frontend"),
        },
        readModel,
      });
      const event = Array.isArray(decided) ? decided[0]! : decided;
      expect(event.type).toBe("workspace.deleted");
      if (event.type === "workspace.deleted") {
        expect(event.payload.workspaceId).toBe("workspace-frontend");
      }
    }),
  );
});

it.layer(NodeServices.layer)("workspace projector", (it) => {
  it.effect("folds create, meta-update and delete into readModel.workspaces", () =>
    Effect.gen(function* () {
      const created = yield* seedWithWorkspace;
      expect(created.workspaces).toHaveLength(1);
      expect(created.workspaces[0]!.title).toBe("Frontend");
      expect(created.workspaces[0]!.deletedAt).toBeNull();

      const updated = yield* projectEvent(created, {
        sequence: 2,
        eventId: asEventId("evt-workspace-update"),
        aggregateKind: "workspace",
        aggregateId: asWorkspaceId("workspace-frontend"),
        type: "workspace.meta-updated",
        occurredAt: now,
        commandId: asCommandId("cmd-workspace-update"),
        causationEventId: null,
        correlationId: asCommandId("cmd-workspace-update"),
        metadata: {},
        payload: {
          workspaceId: asWorkspaceId("workspace-frontend"),
          title: "Renamed",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          updatedAt: now,
        },
      });
      expect(updated.workspaces[0]!.title).toBe("Renamed");
      expect(updated.workspaces[0]!.defaultModelSelection).not.toBeNull();
      expect(updated.workspaces[0]!.members.map((m: { label: string }) => m.label)).toEqual([
        "web",
        "mobile",
      ]);

      const deleted = yield* projectEvent(updated, {
        sequence: 3,
        eventId: asEventId("evt-workspace-delete"),
        aggregateKind: "workspace",
        aggregateId: asWorkspaceId("workspace-frontend"),
        type: "workspace.deleted",
        occurredAt: now,
        commandId: asCommandId("cmd-workspace-delete"),
        causationEventId: null,
        correlationId: asCommandId("cmd-workspace-delete"),
        metadata: {},
        payload: {
          workspaceId: asWorkspaceId("workspace-frontend"),
          deletedAt: now,
        },
      });
      expect(deleted.workspaces[0]!.deletedAt).toBe(now);
    }),
  );
});
