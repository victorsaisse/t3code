import type { ProviderSessionRepo } from "@t3tools/contracts";

/**
 * Build the compact repo-manifest text injected into a workspace-thread agent
 * session (Claude `systemPrompt.append`, Codex `developerInstructions`). Kept
 * small and stable to preserve provider prompt-cache hits.
 */
export function buildRepoManifestText(repos: ReadonlyArray<ProviderSessionRepo>): string {
  if (repos.length === 0) {
    return "";
  }
  const rows = repos.map((repo) => {
    const description = repo.description ? ` — ${repo.description}` : "";
    return `- \`${repo.label}\` at ${repo.path}${description}`;
  });
  return [
    "You are working in a multi-repo workspace. Each member repository below is a",
    "separate git repository mounted as a subfolder of your working directory:",
    "",
    ...rows,
    "",
    "Edit files inside the relevant repo subfolder. The working directory itself is",
    "not a git repository — never run git there; run git inside a member subfolder.",
  ].join("\n");
}
