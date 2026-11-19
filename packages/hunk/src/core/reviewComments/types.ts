/**
 * Value shapes for the local two-way review-comment lifecycle.
 *
 * These records live beside a repository, outside its working tree, and are independent of the
 * shared in-memory review model. A comment may reference a `ReviewNote` by id when it originated in
 * a TUI note, but the lifecycle never mutates that model: status, resolution notes, and agent
 * replies belong here so the terminal, the agent CLI, and a future surface can all read the same
 * local record without changing the shared review seam.
 */
import type { ReviewSide } from "../review/types";

/** The four states a review comment can be in during a two-way review loop. */
export type ReviewCommentStatus = "open" | "resolved" | "disputed" | "outdated";

/** Who wrote a comment or one of its replies. */
export type ReviewCommentAuthorRole = "user" | "agent";

/** One message in a comment's thread. */
export interface ReviewCommentReply {
  id: string;
  author: string;
  authorRole: ReviewCommentAuthorRole;
  text: string;
  createdAt: string;
  /** Terminal note id when the reply was written in the TUI rather than by the agent. */
  noteId?: string;
}

/** One review comment with its anchor, lifecycle status, and thread. */
export interface ReviewComment {
  id: string;
  /** Terminal note id when this comment was created from a TUI note. */
  noteId?: string;
  /** Repository-relative file path. */
  file: string;
  side: ReviewSide;
  line: number;
  hunkIndex?: number;
  /** Source-line text captured when the note was written, used to re-anchor after edits. */
  anchorText?: string;
  text: string;
  author: string;
  authorRole: ReviewCommentAuthorRole;
  status: ReviewCommentStatus;
  createdAt: string;
  updatedAt: string;
  /** Short explanation supplied when the comment was resolved. */
  resolutionNote?: string;
  replies: ReviewCommentReply[];
}

/** The complete on-disk comment document. The version travels with the payload. */
export interface ReviewCommentDocument {
  version: 1;
  comments: ReviewComment[];
}

/** Create an empty comment document. */
export function createEmptyCommentDocument(): ReviewCommentDocument {
  return { version: 1, comments: [] };
}
