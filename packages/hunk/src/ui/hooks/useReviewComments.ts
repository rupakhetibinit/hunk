/**
 * Polls the local review-comment file for the terminal surface.
 *
 * The agent writes lifecycle changes to a JSON file beside the repository with no daemon
 * involved. Polling that file keeps the TUI in sync with those changes portably (including on
 * Windows) and avoids adding an agent command to the session wire. A store update from the TUI
 * itself uses the same file, so both directions converge on one record.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildCommentStatusByNoteId, readCommentDocument } from "../../core/reviewComments/store";
import type { ReviewComment, ReviewCommentStatus } from "../../core/reviewComments/types";

/** Delay between comment-file reads while a review is mounted. */
const COMMENT_POLL_INTERVAL_MS = 750;

/** Options for the live comment view. */
export interface UseReviewCommentsOptions {
  cwd?: string;
  storePath?: string;
  enabled?: boolean;
}

/** The comment data the TUI needs for rendering and keyboard actions. */
export interface ReviewCommentsView {
  comments: ReviewComment[];
  statusByNoteId: Map<string, ReviewCommentStatus>;
  commentByNoteId: Map<string, ReviewComment>;
  refresh: () => void;
}

/** Watch the local comment store and expose status lookups keyed by terminal note id. */
export function useReviewComments(options: UseReviewCommentsOptions = {}): ReviewCommentsView {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (options.enabled === false) return;
    let mounted = true;
    const read = () => {
      const next = readCommentDocument({ cwd: options.cwd, storePath: options.storePath }).comments;
      if (!mounted) return;
      setComments((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    read();
    const timer = setInterval(read, COMMENT_POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [options.cwd, options.storePath, options.enabled, refreshKey]);

  const statusByNoteId = useMemo(
    () => buildCommentStatusByNoteId({ version: 1, comments }),
    [comments],
  );

  const commentByNoteId = useMemo(() => {
    const map = new Map<string, ReviewComment>();
    for (const comment of comments) {
      if (comment.noteId) map.set(comment.noteId, comment);
      for (const reply of comment.replies) {
        if (reply.noteId) map.set(reply.noteId, comment);
      }
    }
    return map;
  }, [comments]);

  return { comments, statusByNoteId, commentByNoteId, refresh };
}
