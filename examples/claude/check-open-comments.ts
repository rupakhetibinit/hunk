#!/usr/bin/env bun
/**
 * Example Claude Code Stop hook: remind the agent about open Hunk review comments.
 *
 * This file is documentation, not an installed hook. See the README's "Stop hook" section for
 * the `.claude/settings.json` snippet that runs it. It exits successfully either way; a Stop
 * hook that blocks returns `decision: "block"` with a reason rather than a failure exit code.
 */
import { spawnSync } from "node:child_process";

const checked = spawnSync("hunk", ["comment", "list", "--json"], { encoding: "utf8" });
if (checked.status !== 0) {
  // A missing CLI or store is not a review failure; say so and let the turn end normally.
  console.log(
    JSON.stringify({
      decision: "block",
      reason:
        "Could not check Hunk review comments. Install Hunk or run `/review-comments` manually.",
    }),
  );
  process.exit(0);
}

let count = 0;
try {
  count = JSON.parse(checked.stdout).count ?? 0;
} catch {
  // Ignore malformed output; the agent can still use the slash command explicitly.
}

if (count > 0) {
  console.log(
    JSON.stringify({
      decision: "block",
      reason: `${count} open Hunk review comment(s) remain. Run /review-comments and resolve or dispute each one before finishing.`,
    }),
  );
}
