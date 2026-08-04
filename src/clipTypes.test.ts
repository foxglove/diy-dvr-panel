import { ClipMeta, planEviction } from "./clipTypes";

function clip(
  overrides: Partial<ClipMeta> & Pick<ClipMeta, "id" | "trigger" | "createdAt">,
): ClipMeta {
  return {
    triggerLabel: overrides.trigger,
    startNanos: "0",
    endNanos: "0",
    durationSec: 0,
    byteSize: 100,
    messageCount: 1,
    topicCounts: { "/a": 1 },
    sealed: true,
    ...overrides,
  };
}

describe("planEviction", () => {
  it("drops nothing when the cache already fits", () => {
    const clips = [
      clip({ id: "a", trigger: "gap", createdAt: 1 }),
      clip({ id: "b", trigger: "manual-clip", createdAt: 2 }),
    ];
    expect(planEviction(clips, 500)).toEqual([]);
  });

  it("drops nothing when there is nothing cached", () => {
    expect(planEviction([], 0)).toEqual([]);
  });

  it("drops the oldest first among clips the user asked for", () => {
    const clips = [
      clip({ id: "oldest", trigger: "gap", createdAt: 1 }),
      clip({ id: "middle", trigger: "rotation", createdAt: 2 }),
      clip({ id: "newest", trigger: "manual-clip", createdAt: 3 }),
    ];
    expect(planEviction(clips, 250).map((c) => c.id)).toEqual(["oldest"]);
    expect(planEviction(clips, 150).map((c) => c.id)).toEqual(["oldest", "middle"]);
  });

  it("drops recovered clips before anything the user asked for", () => {
    // The recovered clip is the newest, so plain oldest-first would have spared it.
    const clips = [
      clip({ id: "gap", trigger: "gap", createdAt: 1 }),
      clip({ id: "manual", trigger: "manual-clip", createdAt: 2 }),
      clip({ id: "recovered", trigger: "recovered", createdAt: 99 }),
    ];
    expect(planEviction(clips, 250).map((c) => c.id)).toEqual(["recovered"]);
  });

  it("always keeps one clip, even when it alone exceeds the cap", () => {
    const clips = [
      clip({ id: "a", trigger: "gap", createdAt: 1, byteSize: 900 }),
      clip({ id: "b", trigger: "gap", createdAt: 2, byteSize: 900 }),
    ];
    expect(planEviction(clips, 0).map((c) => c.id)).toEqual(["a"]);
    expect(planEviction([clip({ id: "solo", trigger: "gap", createdAt: 1 })], 0)).toEqual([]);
  });

  it("reports exactly what a lower limit costs, which is what the panel warns about", () => {
    const clips = [
      clip({ id: "a", trigger: "gap", createdAt: 1, byteSize: 300 }),
      clip({ id: "b", trigger: "gap", createdAt: 2, byteSize: 300 }),
      clip({ id: "c", trigger: "gap", createdAt: 3, byteSize: 300 }),
    ];
    const doomed = planEviction(clips, 400);
    expect(doomed.map((c) => c.id)).toEqual(["a", "b"]);
    expect(doomed.reduce((total, c) => total + c.byteSize, 0)).toBe(600);
  });

  it("leaves the cache untouched when the limit is raised", () => {
    const clips = [clip({ id: "a", trigger: "gap", createdAt: 1, byteSize: 300 })];
    expect(planEviction(clips, 4096)).toEqual([]);
  });
});
