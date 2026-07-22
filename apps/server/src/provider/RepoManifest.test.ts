import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRepoManifestText } from "./RepoManifest.ts";

describe("buildRepoManifestText", () => {
  it("returns an empty string when there are no repos", () => {
    expect(buildRepoManifestText([])).toBe("");
  });

  it("lists each member repo with its label and path", () => {
    const text = buildRepoManifestText([
      { label: "web", path: "/root/web", projectId: ProjectId.make("p-web") },
      {
        label: "api",
        path: "/root/api",
        projectId: ProjectId.make("p-api"),
        description: "backend",
      },
    ]);
    expect(text).toContain("`web` at /root/web");
    expect(text).toContain("`api` at /root/api — backend");
    // agents must be told the root itself is not a git repo
    expect(text).toContain("not a git repository");
  });
});
