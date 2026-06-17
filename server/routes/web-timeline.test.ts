import { describe, expect, it } from "vitest";
import type { ForgejoTimelineEvent } from "../forgejo-types.js";
import { compareWebTimelineItems, webTimelineDescriptionHtml, webTimelineDescriptionText } from "./web-timeline.js";

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
      String(webTimelineDescriptionHtml(event({ type: "label", label: { id: 1, name: '<img src=x onerror="alert(1)">', color: "fff" } }))),
    ).toBe("added the &lt;img src=x onerror=&quot;alert(1)&quot;&gt; label");
  });

  it("keeps the plain-text formatter available for route-independent behavior", () => {
    expect(webTimelineDescriptionText(event({ type: "issue_ref", ref_issue: { number: 42 } as unknown as number }))).toBe(
      "referenced this in #42",
    );
  });

  it("does not render malformed issue references from Forgejo timeline payloads", () => {
    expect(webTimelineDescriptionText(event({ type: "issue_ref", ref_issue: -7 }))).toBe("referenced this");
    expect(webTimelineDescriptionText(event({ type: "pull_ref", ref_issue: { number: 0 } as unknown as number }))).toBe(
      "referenced this in a pull request",
    );
  });
});

describe("web timeline ordering", () => {
  it("shows a submitted review before a same-second merge event", () => {
    const ts = Date.parse("2026-05-24T22:05:44Z");
    const items = [
      { kind: "event" as const, ts, event: { id: 25, type: "merge_pull" } },
      { kind: "review" as const, ts, review: { id: 18 } },
    ].sort(compareWebTimelineItems);

    expect(items.map((item) => item.kind)).toEqual(["review", "event"]);
  });

  it("keeps same-kind ties deterministic by Forgejo id", () => {
    const ts = Date.parse("2026-05-24T22:05:44Z");
    const items = [
      { kind: "event" as const, ts, event: { id: 25, type: "label" } },
      { kind: "event" as const, ts, event: { id: 24, type: "milestone" } },
    ].sort(compareWebTimelineItems);

    expect(items.map((item) => item.event?.id)).toEqual([24, 25]);
  });
});
