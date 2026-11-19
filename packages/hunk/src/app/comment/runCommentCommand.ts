/**
 * Runs the local review-comment commands and renders their output.
 *
 * These commands never contact the session daemon or a remote: they read and update the JSON
 * document beside the current repository, so an agent can address comments without a live TUI.
 */
import type { CommentCommandInput } from "../../core/run/commandInputs";
import {
  disputeReviewComment,
  listReviewComments,
  refreshCommentAnchors,
  reopenReviewComment,
  replyToReviewComment,
  resolveReviewComment,
  type ReviewCommentStoreContext,
} from "../../core/reviewComments/store";
import type { ReviewComment } from "../../core/reviewComments/types";
import { stringifyJson } from "../../session/agent/cliClient";

/** Short single-line rendering for one comment. */
function formatCommentLine(comment: ReviewComment) {
  return `${comment.id}  ${comment.status.padEnd(8)}  ${comment.file}:${comment.line}  ${comment.text}`;
}

/** Render a command result as either structured JSON or a short human line. */
function render(input: CommentCommandInput, value: unknown, formatText: () => string) {
  return input.output === "json" ? stringifyJson(value) : formatText();
}

/** Execute one parsed `hunk comment` command and return its stdout payload. */
export async function runCommentCommand(
  input: CommentCommandInput,
  context: ReviewCommentStoreContext = { cwd: process.cwd() },
) {
  switch (input.action) {
    case "list": {
      refreshCommentAnchors(context);
      const comments = listReviewComments(context, { all: input.all, status: input.status });
      return render(input, { comments, count: comments.length }, () =>
        comments.length === 0
          ? "No open review comments.\n"
          : `${comments.map(formatCommentLine).join("\n")}\n`,
      );
    }
    case "resolve": {
      const comment = resolveReviewComment(input.id!, input.note!, context);
      return render(
        input,
        { comment },
        () => `Resolved ${comment.id}: ${comment.resolutionNote}\n`,
      );
    }
    case "reply": {
      const reply = replyToReviewComment(input.id!, input.text!, context);
      return render(input, { reply }, () => `Replied to ${input.id}: ${reply.text}\n`);
    }
    case "dispute": {
      const comment = disputeReviewComment(input.id!, input.text!, context);
      return render(input, { comment }, () => `Disputed ${comment.id}: ${input.text}\n`);
    }
    case "reopen": {
      const comment = reopenReviewComment(input.id!, context);
      return render(input, { comment }, () => `Reopened ${comment.id}.\n`);
    }
  }
}
