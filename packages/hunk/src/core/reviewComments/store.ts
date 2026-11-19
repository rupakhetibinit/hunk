/**
 * Reads and updates the local review-comment document.
 *
 * Every operation loads the file, applies one transition, and publishes the result with a
 * sibling temp-file rename so a crashed or concurrent process sees either the old document or the
 * new one. Writers do not hold a lock: the small lost-update window is preferable to a lock file
 * that has to be reaped after a crash. Paths and ids stay inside this module so callers only deal
 * with semantic operations.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { reviewContentDigest } from "../review/identity";
import { resolveUserStateDir } from "../run/paths";
import {
  createEmptyCommentDocument,
  type ReviewComment,
  type ReviewCommentAuthorRole,
  type ReviewCommentDocument,
  type ReviewCommentReply,
  type ReviewCommentStatus,
} from "./types";

/** Environment variable that overrides the computed comment-store path. */
export const HUNK_COMMENTS_PATH_ENV = "HUNK_COMMENTS_PATH";

/** Options shared by every comment-store operation. */
export interface ReviewCommentStoreContext {
  /** Explicit store file, primarily for tests and advanced setups. */
  storePath?: string;
  /** Canonical repository root used for path hashing and content re-anchoring. */
  repoRoot?: string;
  /** Directory to walk upward from when `repoRoot` is not supplied. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Override working-tree reads for re-anchoring in tests. */
  readRepoFile?: (file: string) => string | undefined;
}

/** Locate the repository root by walking upward for a `.git` marker, without spawning git. */
export function resolveCommentRepoRoot(cwd: string = process.cwd()) {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/**
 * Resolve the per-repository comment file under the user state dir.
 *
 * The repo root is hashed into the file name so two checkouts never share a thread. Returns
 * `undefined` only when no state directory can be resolved at all.
 */
export function resolveCommentStorePath(context: ReviewCommentStoreContext = {}) {
  const env = context.env ?? process.env;
  const override = context.storePath ?? env[HUNK_COMMENTS_PATH_ENV];
  if (override) return isAbsolute(override) ? override : resolve(override);

  const stateDir = resolveUserStateDir(env);
  if (!stateDir) return undefined;
  const repoRoot = context.repoRoot ?? resolveCommentRepoRoot(context.cwd ?? process.cwd());
  return join(stateDir, "hunk", "comments", `${reviewContentDigest([repoRoot])}.json`);
}

/** Parse a persisted document, quarantining unreadable bytes rather than trusting them. */
export function parseCommentDocument(text: string): ReviewCommentDocument {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { comments?: unknown }).comments)
  ) {
    throw new Error("Invalid review comment document.");
  }
  const comments = (parsed as { comments: unknown[] }).comments.filter(isReviewComment);
  return { version: 1, comments };
}

function isReviewComment(value: unknown): value is ReviewComment {
  if (typeof value !== "object" || value === null) return false;
  const comment = value as Partial<ReviewComment>;
  return (
    typeof comment.id === "string" &&
    typeof comment.file === "string" &&
    typeof comment.line === "number" &&
    typeof comment.text === "string" &&
    typeof comment.status === "string" &&
    Array.isArray(comment.replies)
  );
}

function withTimestamp(context: ReviewCommentStoreContext) {
  return (context.now ?? (() => new Date()))().toISOString();
}

/** Read one comment document; a missing or corrupt file yields an empty document. */
export function readCommentDocument(
  context: ReviewCommentStoreContext = {},
): ReviewCommentDocument {
  const path = resolveCommentStorePath(context);
  if (!path || !existsSync(path)) return createEmptyCommentDocument();
  try {
    return parseCommentDocument(readFileSync(path, "utf8"));
  } catch {
    // Preserve the damaged bytes beside the store instead of silently resetting the file.
    try {
      renameSync(path, `${path}.corrupt-${randomUUID().slice(0, 8)}`);
    } catch {
      // Best effort: a read still has to succeed so the reviewer is not locked out.
    }
    return createEmptyCommentDocument();
  }
}

/** Write one comment document atomically with owner-only permissions. */
export function writeCommentDocument(
  document: ReviewCommentDocument,
  context: ReviewCommentStoreContext = {},
) {
  const path = resolveCommentStorePath(context);
  if (!path) {
    throw new Error(
      "Could not resolve a comment store path because no state directory is available.",
    );
  }
  writeAtomicJson(path, document);
  return path;
}

function writeAtomicJson(path: string, document: ReviewCommentDocument) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });

  try {
    renameSync(tempPath, path);
  } catch {
    // Windows can refuse a rename over a file another process still holds open.
    try {
      rmSync(path, { force: true });
      renameSync(tempPath, path);
    } catch {
      writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
      rmSync(tempPath, { force: true });
    }
  }
}

function mutate<T>(
  context: ReviewCommentStoreContext,
  change: (document: ReviewCommentDocument, timestamp: string) => T,
): T {
  const document = readCommentDocument(context);
  const result = change(document, withTimestamp(context));
  writeCommentDocument(document, context);
  return result;
}

function requireComment(document: ReviewCommentDocument, id: string) {
  const comment = document.comments.find((candidate) => candidate.id === id);
  if (!comment) throw new Error(`No review comment matches id ${id}.`);
  return comment;
}

/** Input accepted when a new comment is recorded from a TUI note. */
export interface CreateReviewCommentInput {
  noteId?: string;
  file: string;
  side: ReviewComment["side"];
  line: number;
  hunkIndex?: number;
  anchorText?: string;
  text: string;
  author?: string;
  authorRole?: ReviewCommentAuthorRole;
}

function newComment(input: CreateReviewCommentInput, timestamp: string): ReviewComment {
  return {
    id: `c-${randomUUID()}`,
    ...(input.noteId ? { noteId: input.noteId } : {}),
    file: input.file,
    side: input.side,
    line: input.line,
    ...(input.hunkIndex === undefined ? {} : { hunkIndex: input.hunkIndex }),
    ...(input.anchorText === undefined ? {} : { anchorText: input.anchorText }),
    text: input.text,
    author: input.author ?? (input.authorRole === "agent" ? "claude" : "user"),
    authorRole: input.authorRole ?? "user",
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp,
    replies: [],
  };
}

function requireText(text: string, label: string) {
  if (!text.trim()) throw new Error(`${label} must not be empty.`);
  return text;
}

function appendReply(
  comment: ReviewComment,
  text: string,
  authorRole: ReviewCommentAuthorRole,
  author: string,
  timestamp: string,
  noteId?: string,
): ReviewCommentReply {
  const reply: ReviewCommentReply = {
    id: `r-${randomUUID()}`,
    author,
    authorRole,
    text,
    createdAt: timestamp,
    ...(noteId ? { noteId } : {}),
  };
  comment.replies.push(reply);
  comment.updatedAt = timestamp;
  return reply;
}

/** List comments, open by default, newest last. */
export function listReviewComments(
  context: ReviewCommentStoreContext = {},
  options: { all?: boolean; status?: ReviewCommentStatus } = {},
) {
  const document = readCommentDocument(context);
  return document.comments.filter((comment) =>
    options.all
      ? true
      : options.status
        ? comment.status === options.status
        : comment.status === "open",
  );
}

/** Record a new open comment. A note id can be supplied only once. */
export function createReviewComment(
  input: CreateReviewCommentInput,
  context: ReviewCommentStoreContext = {},
) {
  return mutate(context, (document, timestamp) => {
    requireText(input.text, "Comment text");
    if (input.noteId && document.comments.some((comment) => comment.noteId === input.noteId)) {
      return {
        document,
        comment: document.comments.find((comment) => comment.noteId === input.noteId)!,
      };
    }
    const comment = newComment(input, timestamp);
    document.comments.push(comment);
    return { document, comment };
  }).comment;
}

/** Resolve a comment with a short note describing what changed. */
export function resolveReviewComment(
  id: string,
  note: string,
  context: ReviewCommentStoreContext = {},
) {
  return mutate(context, (document, timestamp) => {
    const comment = requireComment(document, id);
    requireText(note, "Resolution note");
    comment.status = "resolved";
    comment.resolutionNote = note;
    comment.updatedAt = timestamp;
    return comment;
  });
}

/** Add a reply to a comment without changing its status. */
export function replyToReviewComment(
  id: string,
  text: string,
  context: ReviewCommentStoreContext = {},
  options: { authorRole?: ReviewCommentAuthorRole; author?: string; noteId?: string } = {},
) {
  return mutate(context, (document, timestamp) => {
    const comment = requireComment(document, id);
    requireText(text, "Reply text");
    return appendReply(
      comment,
      text,
      options.authorRole ?? "agent",
      options.author ?? (options.authorRole === "user" ? "user" : "claude"),
      timestamp,
      options.noteId,
    );
  });
}

/** Dispute a comment: the agent disagrees, leaves code unchanged, and explains why. */
export function disputeReviewComment(
  id: string,
  text: string,
  context: ReviewCommentStoreContext = {},
) {
  return mutate(context, (document, timestamp) => {
    const comment = requireComment(document, id);
    requireText(text, "Dispute reason");
    comment.status = "disputed";
    appendReply(comment, text, "agent", "claude", timestamp);
    return comment;
  });
}

/** Reopen a resolved or outdated comment. */
export function reopenReviewComment(id: string, context: ReviewCommentStoreContext = {}) {
  return mutate(context, (document, timestamp) => {
    const comment = requireComment(document, id);
    comment.status = "open";
    comment.resolutionNote = undefined;
    comment.updatedAt = timestamp;
    return comment;
  });
}

/** Mark a comment outdated when its anchor can no longer be found. */
export function markReviewCommentOutdated(id: string, context: ReviewCommentStoreContext = {}) {
  return mutate(context, (document, timestamp) => {
    const comment = requireComment(document, id);
    comment.status = "outdated";
    comment.updatedAt = timestamp;
    return comment;
  });
}

function defaultReadRepoFile(context: ReviewCommentStoreContext) {
  const root = context.repoRoot ?? resolveCommentRepoRoot(context.cwd ?? process.cwd());
  return (file: string) => {
    const target = resolve(root, file);
    if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;
    try {
      return readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  };
}

/**
 * Re-anchor comments against the working tree.
 *
 * An `anchorText` match updates the line; no match marks an open/disputed comment `outdated`. A
 * rediscovered anchor restores an `outdated` comment to `open`. Resolved comments are left alone
 * and `old`-side anchors (deleted lines) keep their line because the new file cannot contain them.
 */
export function reanchorCommentDocument(
  document: ReviewCommentDocument,
  context: ReviewCommentStoreContext = {},
): ReviewCommentDocument {
  const read = context.readRepoFile ?? defaultReadRepoFile(context);
  const timestamp = withTimestamp(context);
  let changed = false;

  const comments = document.comments.map((comment) => {
    if (comment.status === "resolved") return comment;
    const content = read(comment.file);
    if (content === undefined) {
      if (comment.status === "outdated") return comment;
      changed = true;
      return { ...comment, status: "outdated" as const, updatedAt: timestamp };
    }
    if (comment.side === "old" || !comment.anchorText) return comment;

    const matches: number[] = [];
    content.split(/\r?\n/).forEach((line, index) => {
      if (line === comment.anchorText) matches.push(index + 1);
    });
    if (matches.length === 0) {
      if (comment.status === "outdated") return comment;
      changed = true;
      return { ...comment, status: "outdated" as const, updatedAt: timestamp };
    }
    const line = matches[0]!;
    if (line === comment.line && comment.status !== "outdated") return comment;
    changed = true;
    return {
      ...comment,
      line,
      status: comment.status === "outdated" ? ("open" as const) : comment.status,
      updatedAt: timestamp,
    };
  });

  return changed ? { ...document, comments } : document;
}

/** Re-anchor and persist when the anchors moved, returning the current document. */
export function refreshCommentAnchors(context: ReviewCommentStoreContext = {}) {
  const document = readCommentDocument(context);
  const refreshed = reanchorCommentDocument(document, context);
  if (refreshed !== document) writeCommentDocument(refreshed, context);
  return refreshed;
}

/** Find the comment whose root or reply carries a terminal note id. */
export function findCommentByNoteId(document: ReviewCommentDocument, noteId: string) {
  return document.comments.find(
    (comment) =>
      comment.noteId === noteId || comment.replies.some((reply) => reply.noteId === noteId),
  );
}

/** Capture the working-tree source line a new note is anchored to, when it exists. */
export function readAnchorText(
  file: string,
  side: "old" | "new",
  line: number,
  context: ReviewCommentStoreContext = {},
) {
  if (side === "old") return undefined;
  const content = (context.readRepoFile ?? defaultReadRepoFile(context))(file);
  return content?.split(/\r?\n/)[line - 1];
}

/** Map every tracked note id (roots and replies) to its root comment's status. */
export function buildCommentStatusByNoteId(document: ReviewCommentDocument) {
  const status = new Map<string, ReviewCommentStatus>();
  for (const comment of document.comments) {
    status.set(comment.id, comment.status);
    if (comment.noteId) status.set(comment.noteId, comment.status);
    for (const reply of comment.replies) {
      if (reply.noteId) status.set(reply.noteId, comment.status);
    }
  }
  return status;
}

/** Read the refreshed document for a context. */
export function loadRefreshedComments(context: ReviewCommentStoreContext = {}) {
  return refreshCommentAnchors(context);
}
