import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommentStatusByNoteId,
  createReviewComment,
  disputeReviewComment,
  listReviewComments,
  readCommentDocument,
  reanchorCommentDocument,
  reopenReviewComment,
  replyToReviewComment,
  resolveReviewComment,
  resolveCommentStorePath,
} from "./store";
import { createEmptyCommentDocument, type ReviewCommentDocument } from "./types";

const directories: string[] = [];
const NOW = "2026-11-19T00:00:00.000Z";

function createContext(files: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-comments-"));
  directories.push(cwd);
  const storePath = join(cwd, "comments.json");
  return {
    context: {
      storePath,
      cwd,
      repoRoot: cwd,
      now: () => new Date(NOW),
      readRepoFile: (file: string) => files[file],
    },
    storePath,
  };
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("comment store paths", () => {
  test("honors an explicit store path override", () => {
    const { context, storePath } = createContext();
    expect(resolveCommentStorePath(context)).toBe(storePath);
  });

  test("hashes the repo root under a dedicated XDG state directory", () => {
    const stateHome = mkdtempSync(join(tmpdir(), "hunk-xdg-"));
    directories.push(stateHome);
    const path = resolveCommentStorePath({
      repoRoot: "/work/repo",
      env: { XDG_STATE_HOME: stateHome, HOME: stateHome },
    })!;
    expect(path.startsWith(stateHome)).toBe(true);
    expect(path).toContain(join("hunk", "comments"));
    expect(path).toMatch(/[0-9a-f]{32}\.json$/);
  });
});

describe("comment lifecycle", () => {
  test("creates open comments and lists open by default", () => {
    const { context } = createContext();
    const first = createReviewComment(
      { file: "src/a.ts", side: "new", line: 12, text: "Fix this", noteId: "user:1" },
      context,
    );
    expect(first.status).toBe("open");
    expect(first.authorRole).toBe("user");
    expect(listReviewComments(context)).toHaveLength(1);

    resolveReviewComment(first.id, "fixed in latest revision", context);
    expect(listReviewComments(context)).toHaveLength(0);
    expect(listReviewComments(context, { all: true })).toHaveLength(1);
    expect(listReviewComments(context, { status: "resolved" })[0]?.resolutionNote).toBe(
      "fixed in latest revision",
    );
  });

  test("reuses an existing comment when the same note id is recorded twice", () => {
    const { context } = createContext();
    const input = {
      file: "src/a.ts",
      side: "new" as const,
      line: 1,
      text: "Note",
      noteId: "user:1",
    };
    const first = createReviewComment(input, context);
    const second = createReviewComment(input, context);
    expect(second.id).toBe(first.id);
    expect(readCommentDocument(context).comments).toHaveLength(1);
  });

  test("appends replies without changing status", () => {
    const { context } = createContext();
    const comment = createReviewComment({ file: "a.ts", side: "new", line: 1, text: "N" }, context);
    replyToReviewComment(comment.id, "Looking into it", context);
    expect(readCommentDocument(context).comments[0]?.replies).toMatchObject([
      { author: "claude", authorRole: "agent", text: "Looking into it" },
    ]);
    expect(readCommentDocument(context).comments[0]?.status).toBe("open");
  });

  test("disputes and reopens", () => {
    const { context } = createContext();
    const comment = createReviewComment(
      { file: "a.ts", side: "new", line: 1, text: "N", noteId: "user:9" },
      context,
    );
    const disputed = disputeReviewComment(comment.id, "Intentional", context);
    expect(disputed.status).toBe("disputed");
    expect(disputed.replies[0]?.text).toBe("Intentional");

    const reopened = reopenReviewComment(comment.id, context);
    expect(reopened.status).toBe("open");
    expect(reopened.resolutionNote).toBeUndefined();
  });

  test("rejects blank text and unknown ids", () => {
    const { context } = createContext();
    expect(() =>
      createReviewComment({ file: "a", side: "new", line: 1, text: "  " }, context),
    ).toThrow("Comment text must not be empty.");
    expect(() => resolveReviewComment("missing", "ok", context)).toThrow(
      "No review comment matches id missing.",
    );
    expect(() => replyToReviewComment("missing", "x", context)).toThrow(
      "No review comment matches id missing.",
    );
  });

  test("creates missing parent directories on first write", () => {
    const { context } = createContext();
    const storePath = join(context.cwd!, "nested", "state", "comments.json");
    createReviewComment({ file: "a.ts", side: "new", line: 1, text: "N" }, { storePath });
    expect(readFileSync(storePath, "utf8")).toContain('"status": "open"');
  });

  test("writes readable JSON to disk", () => {
    const { context, storePath } = createContext();
    createReviewComment({ file: "a.ts", side: "new", line: 2, text: "N" }, context);
    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.comments[0]).toMatchObject({ file: "a.ts", line: 2, status: "open" });
  });
});

describe("anchoring", () => {
  test("re-anchors a moved line and restores an outdated comment", () => {
    const document: ReviewCommentDocument = {
      ...createEmptyCommentDocument(),
      comments: [
        {
          id: "c-1",
          file: "a.ts",
          side: "new",
          line: 1,
          anchorText: "const answer = 42;",
          text: "Check this",
          author: "user",
          authorRole: "user",
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
          replies: [],
        },
      ],
    };
    const moved = reanchorCommentDocument(document, {
      readRepoFile: () => "header\nconst answer = 42;\n",
      now: () => new Date(NOW),
    });
    expect(moved.comments[0]?.line).toBe(2);

    const lost = reanchorCommentDocument(moved, {
      readRepoFile: () => "nothing here\n",
      now: () => new Date(NOW),
    });
    expect(lost.comments[0]?.status).toBe("outdated");

    const restored = reanchorCommentDocument(lost, {
      readRepoFile: () => "x\nconst answer = 42;\n",
      now: () => new Date(NOW),
    });
    expect(restored.comments[0]?.status).toBe("open");
    expect(restored.comments[0]?.line).toBe(2);
  });

  test("leaves resolved comments and deleted-side anchors alone", () => {
    const document = createEmptyCommentDocument();
    document.comments.push(
      {
        id: "c-1",
        file: "a.ts",
        side: "new",
        line: 1,
        anchorText: "gone",
        text: "Done",
        author: "user",
        authorRole: "user",
        status: "resolved",
        createdAt: NOW,
        updatedAt: NOW,
        replies: [],
      },
      {
        id: "c-2",
        file: "a.ts",
        side: "old",
        line: 7,
        anchorText: "deleted line",
        text: "Old side",
        author: "user",
        authorRole: "user",
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
        replies: [],
      },
    );
    const next = reanchorCommentDocument(document, { readRepoFile: () => "current\n" });
    expect(next.comments.map((comment) => comment.status)).toEqual(["resolved", "open"]);
    expect(next.comments[1]?.line).toBe(7);
  });

  test("maps root and reply note ids to the thread status", () => {
    const { context } = createContext();
    const comment = createReviewComment(
      { file: "a.ts", side: "new", line: 1, text: "N", noteId: "user:root" },
      context,
    );
    replyToReviewComment(comment.id, "A reply", context, { noteId: "user:reply" });
    disputeReviewComment(comment.id, "Disagree", context);
    const status = buildCommentStatusByNoteId(readCommentDocument(context));
    expect(status.get("user:root")).toBe("disputed");
    expect(status.get("user:reply")).toBe("disputed");
  });
});
