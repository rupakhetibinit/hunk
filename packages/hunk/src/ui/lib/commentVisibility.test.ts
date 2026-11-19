import { describe, expect, test } from "bun:test";
import { isTrackedCommentVisible } from "./commentVisibility";

describe("tracked comment visibility", () => {
  test("keeps untracked and non-resolved comments visible", () => {
    expect(isTrackedCommentVisible(undefined, false)).toBe(true);
    expect(isTrackedCommentVisible("open", false)).toBe(true);
    expect(isTrackedCommentVisible("disputed", false)).toBe(true);
    expect(isTrackedCommentVisible("outdated", false)).toBe(true);
  });

  test("collapses resolved comments until the reviewer toggles them", () => {
    expect(isTrackedCommentVisible("resolved", false)).toBe(false);
    expect(isTrackedCommentVisible("resolved", true)).toBe(true);
  });
});
