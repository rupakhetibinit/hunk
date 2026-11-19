import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createReviewComment } from "../../packages/hunk/src/core/reviewComments/store";

const directories: string[] = [];
const main = resolve(import.meta.dir, "../../packages/hunk/src/main.tsx");

function createCase(files: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-comment-cli-"));
  directories.push(cwd);
  for (const [file, content] of Object.entries(files)) {
    const target = join(cwd, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const storePath = join(cwd, "comments.json");
  const context = {
    storePath,
    cwd,
    repoRoot: cwd,
    readRepoFile: (file: string) => files[file],
  };
  return { cwd, storePath, context };
}

/** Run the source CLI without a terminal, pointed at an isolated comment store. */
function runComment(cwd: string, storePath: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", main, "comment", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HUNK_COMMENTS_PATH: storePath },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("hunk comment CLI", () => {
  test("lists no open comments as JSON", () => {
    const { cwd, storePath } = createCase();
    const result = runComment(cwd, storePath, ["list", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ comments: [], count: 0 });
  });

  test("lists only open comments by default and all with --all", () => {
    const { cwd, storePath, context } = createCase({
      "src/a.ts": "one\ntwo\nthree\nfour\n",
      "src/b.ts": "alpha\nbeta\n",
    });
    const first = createReviewComment(
      { file: "src/a.ts", side: "new", line: 4, anchorText: "four", text: "First" },
      context,
    );
    createReviewComment(
      { file: "src/b.ts", side: "new", line: 2, anchorText: "beta", text: "Second" },
      context,
    );

    const open = JSON.parse(runComment(cwd, storePath, ["list", "--json"]).stdout);
    expect(open.count).toBe(2);

    expect(runComment(cwd, storePath, ["resolve", first.id, "--note", "done", "--json"]).code).toBe(
      0,
    );
    const after = JSON.parse(runComment(cwd, storePath, ["list", "--json"]).stdout);
    expect(after.comments.map((comment: { text: string }) => comment.text)).toEqual(["Second"]);

    const all = JSON.parse(runComment(cwd, storePath, ["list", "--all", "--json"]).stdout);
    expect(all.count).toBe(2);
    expect(all.comments.find((comment: { id: string }) => comment.id === first.id).status).toBe(
      "resolved",
    );
  });

  test("filters by status", () => {
    const { cwd, storePath, context } = createCase({ "a.ts": "N\n" });
    const comment = createReviewComment(
      { file: "a.ts", side: "new", line: 1, anchorText: "N", text: "N" },
      context,
    );
    runComment(cwd, storePath, ["dispute", comment.id, "--text", "no", "--json"]);
    const result = JSON.parse(
      runComment(cwd, storePath, ["list", "--status", "disputed", "--json"]).stdout,
    );
    expect(result.count).toBe(1);
    expect(result.comments[0].replies[0].text).toBe("no");
  });

  test("replies and reopens with JSON output", () => {
    const { cwd, storePath, context } = createCase({ "a.ts": "N\n" });
    const comment = createReviewComment(
      { file: "a.ts", side: "new", line: 1, anchorText: "N", text: "N" },
      context,
    );
    runComment(cwd, storePath, ["resolve", comment.id, "--note", "ok", "--json"]);

    const reply = JSON.parse(
      runComment(cwd, storePath, ["reply", comment.id, "--text", "thanks", "--json"]).stdout,
    );
    expect(reply.reply.authorRole).toBe("agent");

    const reopened = JSON.parse(
      runComment(cwd, storePath, ["reopen", comment.id, "--json"]).stdout,
    );
    expect(reopened.comment.status).toBe("open");
  });

  test("emits compact text output", () => {
    const { cwd, storePath, context } = createCase({ "a.ts": "one\ntwo\nCheck\n" });
    createReviewComment(
      { file: "a.ts", side: "new", line: 3, anchorText: "Check", text: "Check" },
      context,
    );
    const result = runComment(cwd, storePath, ["list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Check");
    expect(result.stdout).toContain("a.ts:3");
  });

  test("reports missing ids and options", () => {
    const { cwd, storePath } = createCase();
    const missing = runComment(cwd, storePath, ["resolve", "missing", "--note", "x", "--json"]);
    expect(missing.code).not.toBe(0);

    const noNote = runComment(cwd, storePath, ["resolve", "c-1"]);
    expect(noNote.code).not.toBe(0);
    expect(noNote.stderr).toContain("--note");
  });

  test("prints help for the comment namespace", () => {
    const { cwd, storePath } = createCase();
    const result = runComment(cwd, storePath, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hunk comment <subcommand>");
  });
});
