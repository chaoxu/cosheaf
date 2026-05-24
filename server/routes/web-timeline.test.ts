import { describe, expect, it } from "vitest";
import type { ForgejoTimelineEvent } from "../forgejo-types.js";
import { webTimelineDescriptionHtml, webTimelineDescriptionText } from "./web-timeline.js";

function event(fields: Partial<ForgejoTimelineEvent>): ForgejoTimelineEvent {
  return {
    id: 1,
    type: "close",
    created_at: "2026-01-01T00:00:00Z",
    ...fields,
  };
}

describe("web timeline descriptions", () => {
  it("escapes Forgejo-provided labels before insertion into server HTML", () => {
    expect(
      webTimelineDescriptionHtml(event({ type: "label", label: { id: 1, name: '<img src=x onerror="alert(1)">', color: "fff" } })),
    ).toBe("added the &lt;img src=x onerror=&quot;alert(1)&quot;&gt; label");
  });

  it("keeps the plain-text formatter available for route-independent behavior", () => {
    expect(webTimelineDescriptionText(event({ type: "issue_ref", ref_issue: { number: 42 } as unknown as number }))).toBe(
      "referenced this in #42",
    );
  });
});
