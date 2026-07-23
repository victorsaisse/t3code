import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorkspaceWorktreeBroker } from "../../WorkspaceWorktreeBroker.ts";
import { WorkspaceToolkit } from "./tools.ts";

const handlers = {
  workspace_list_repos: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("workspace");
      const broker = yield* WorkspaceWorktreeBroker;
      return yield* broker.list({ scope });
    }),
  workspace_attach_repo: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("workspace");
      const broker = yield* WorkspaceWorktreeBroker;
      return yield* broker.attach({ scope, label: input.label });
    }),
} satisfies Parameters<typeof WorkspaceToolkit.toLayer>[0];

export const WorkspaceToolkitHandlersLive = WorkspaceToolkit.toLayer(handlers);
