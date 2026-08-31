import { describe, expect, it } from "vitest";
import type { Issue, ListIssuesCache } from "../types";
import { insertByPosition, patchIssueInBuckets } from "./cache-helpers";

const WS_ID = "ws-1";

function mk(id: string, status: Issue["status"], position: number): Issue {
  return {
    id,
    workspace_id: WS_ID,
    number: 1,
    identifier: `MUL-${id}`,
    title: id,
    description: null,
    status,
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
  properties: {},
    labels: [],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };
}

function cache(byStatus: ListIssuesCache["byStatus"]): ListIssuesCache {
  return { byStatus };
}

function ids(c: ListIssuesCache, status: Issue["status"]): string[] {
  return (c.byStatus[status]?.issues ?? []).map((i) => i.id);
}

describe("insertByPosition", () => {
  it("inserts at the position-sorted slot", () => {
    const a = mk("a", "Queue", 1);
    const c = mk("c", "Queue", 3);
    const b = mk("b", "Queue", 2);
    expect(insertByPosition([a, c], b).map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("appends when the new position is the largest", () => {
    const a = mk("a", "Queue", 1);
    const z = mk("z", "Queue", 9);
    expect(insertByPosition([a], z).map((i) => i.id)).toEqual(["a", "z"]);
  });

  it("prepends when the new position is the smallest", () => {
    const b = mk("b", "Queue", 2);
    const a = mk("a", "Queue", 1);
    expect(insertByPosition([b], a).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("patchIssueInBuckets — cross-status move", () => {
  it("inserts the moved card at its position slot, not the end", () => {
    const c0 = cache({
      "Queue": { issues: [mk("moved", "Queue", 5)], total: 1 },
      "In Progress": {
        issues: [mk("x", "In Progress", 1), mk("y", "In Progress", 3)],
        total: 2,
      },
    });
    // Move "moved" into in_progress at position 2 (between x and y).
    const next = patchIssueInBuckets(c0, "moved", {
      status: "In Progress",
      position: 2,
    });
    expect(ids(next, "In Progress")).toEqual(["x", "moved", "y"]);
    expect(ids(next, "Queue")).toEqual([]);
  });

  it("adjusts both bucket totals", () => {
    const c0 = cache({
      "Queue": { issues: [mk("moved", "Queue", 5)], total: 1 },
      "In Progress": { issues: [mk("x", "In Progress", 1)], total: 1 },
    });
    const next = patchIssueInBuckets(c0, "moved", {
      status: "In Progress",
      position: 2,
    });
    expect(next.byStatus["Queue"]?.total).toBe(0);
    expect(next.byStatus["In Progress"]?.total).toBe(2);
  });

  // MUL-4261: `cancelled` is now a first-class paginated bucket, so cancelling
  // an issue rebuckets it into `cancelled` (instead of dropping it) and the
  // rebucketed card stays locatable for later patches.
  it("rebuckets a cancelled issue and keeps it locatable", () => {
    const c0 = cache({
      "Queue": { issues: [mk("a", "Queue", 1)], total: 1 },
      "Cancelled": { issues: [], total: 0 },
    });
    const cancelled = patchIssueInBuckets(c0, "a", { status: "Cancelled" });
    expect(ids(cancelled, "Queue")).toEqual([]);
    expect(ids(cancelled, "Cancelled")).toEqual(["a"]);
    expect(cancelled.byStatus["Cancelled"]?.total).toBe(1);

    // A follow-up edit still finds the card in the cancelled bucket.
    const renamed = patchIssueInBuckets(cancelled, "a", { title: "renamed" });
    expect(renamed.byStatus["Cancelled"]?.issues[0]?.title).toBe("renamed");
  });
});

describe("patchIssueInBuckets — same status", () => {
  it("keeps the slot for a plain field update (no reorder)", () => {
    const c0 = cache({
      "Queue": {
        issues: [mk("a", "Queue", 1), mk("b", "Queue", 2), mk("c", "Queue", 3)],
        total: 3,
      },
    });
    // A remote label/title edit must not move the card.
    const next = patchIssueInBuckets(c0, "b", { title: "renamed" });
    expect(ids(next, "Queue")).toEqual(["a", "b", "c"]);
    expect(next.byStatus["Queue"]?.issues[1]?.title).toBe("renamed");
  });

  it("re-sorts within the column when position changes", () => {
    const c0 = cache({
      "Queue": {
        issues: [mk("a", "Queue", 1), mk("b", "Queue", 2), mk("c", "Queue", 3)],
        total: 3,
      },
    });
    // Drag "a" below "b" (new position 2.5).
    const next = patchIssueInBuckets(c0, "a", { position: 2.5 });
    expect(ids(next, "Queue")).toEqual(["b", "a", "c"]);
  });
});

describe("patchIssueInBuckets — unknown issue", () => {
  it("returns the cache unchanged when the id is absent", () => {
    const c0 = cache({ "Queue": { issues: [mk("a", "Queue", 1)], total: 1 } });
    expect(patchIssueInBuckets(c0, "ghost", { position: 9 })).toBe(c0);
  });
});
