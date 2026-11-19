/**
 * Terminal policy for which tracked comments stay in the review stream.
 *
 * Untracked notes and non-resolved comments always render. Resolved comments are collapsed away
 * until the reviewer asks to see them; the agent-notes toggle remains a separate shared policy.
 */
import type { ReviewCommentStatus } from "../../core/reviewComments/types";

/** Decide whether one note's comment status keeps it visible in the terminal. */
export function isTrackedCommentVisible(
  status: ReviewCommentStatus | undefined,
  showResolved: boolean,
) {
  return showResolved || status !== "resolved";
}
