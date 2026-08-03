import { SettingsTreeAction } from "@foxglove/extension";

import { applyAction, buildSettingsTree, DEFAULT_CONFIG, DvrConfig } from "./settings";

function update(path: string[], value: unknown): SettingsTreeAction {
  return { action: "update", payload: { path, value, input: "number" } } as SettingsTreeAction;
}

// buildSettingsTree only stores the handler on the returned tree; these tests never invoke it.
const noop = jest.fn();

describe("DEFAULT_CONFIG", () => {
  it("defaults the clip cache to 2048 MB and a 10 s gap trigger", () => {
    expect(DEFAULT_CONFIG.maxCacheMb).toBe(2048);
    expect(DEFAULT_CONFIG.gapThresholdSec).toBe(10);
  });
});

describe("applyAction — cache node", () => {
  it("returns a new config when maxCacheMb changes", () => {
    const next = applyAction(DEFAULT_CONFIG, update(["cache", "maxCacheMb"], 128));
    expect(next).not.toBe(DEFAULT_CONFIG);
    expect(next.maxCacheMb).toBe(128);
    // Nothing else moves.
    expect(next.gapThresholdSec).toBe(DEFAULT_CONFIG.gapThresholdSec);
    expect(next.budgetValue).toBe(DEFAULT_CONFIG.budgetValue);
  });

  it("returns the same reference when maxCacheMb is unchanged", () => {
    const action = update(["cache", "maxCacheMb"], DEFAULT_CONFIG.maxCacheMb);
    expect(applyAction(DEFAULT_CONFIG, action)).toBe(DEFAULT_CONFIG);
  });

  it("returns a new config when gapThresholdSec changes", () => {
    const next = applyAction(DEFAULT_CONFIG, update(["cache", "gapThresholdSec"], 30));
    expect(next).not.toBe(DEFAULT_CONFIG);
    expect(next.gapThresholdSec).toBe(30);
    expect(next.maxCacheMb).toBe(DEFAULT_CONFIG.maxCacheMb);
  });

  it("returns the same reference when gapThresholdSec is unchanged", () => {
    const action = update(["cache", "gapThresholdSec"], DEFAULT_CONFIG.gapThresholdSec);
    expect(applyAction(DEFAULT_CONFIG, action)).toBe(DEFAULT_CONFIG);
  });

  it("ignores an unparseable number", () => {
    expect(applyAction(DEFAULT_CONFIG, update(["cache", "maxCacheMb"], "not a number"))).toBe(
      DEFAULT_CONFIG,
    );
    expect(applyAction(DEFAULT_CONFIG, update(["cache", "gapThresholdSec"], undefined))).toBe(
      DEFAULT_CONFIG,
    );
  });

  it("clamps a negative value to zero", () => {
    const next = applyAction(DEFAULT_CONFIG, update(["cache", "maxCacheMb"], -5));
    expect(next.maxCacheMb).toBe(0);
  });

  it("ignores an unknown field under the cache node", () => {
    expect(applyAction(DEFAULT_CONFIG, update(["cache", "nope"], 1))).toBe(DEFAULT_CONFIG);
  });

  it("ignores non-update actions", () => {
    const action = { action: "perform-node-action", payload: { id: "x", path: ["cache"] } };
    expect(applyAction(DEFAULT_CONFIG, action as SettingsTreeAction)).toBe(DEFAULT_CONFIG);
  });
});

describe("applyAction — existing nodes still behave", () => {
  it("returns the same reference for an unchanged budgetMode", () => {
    const action = update(["general", "budgetMode"], DEFAULT_CONFIG.budgetMode);
    expect(applyAction(DEFAULT_CONFIG, action)).toBe(DEFAULT_CONFIG);
  });

  it("still updates budgetValue", () => {
    const next = applyAction(DEFAULT_CONFIG, update(["general", "budgetValue"], 90));
    expect(next.budgetValue).toBe(90);
    expect(next.maxCacheMb).toBe(DEFAULT_CONFIG.maxCacheMb);
  });

  it("still toggles a topic off and on", () => {
    const off = applyAction(DEFAULT_CONFIG, update(["topics", "/scan"], false));
    expect(off.disabledTopics).toEqual(["/scan"]);
    const on = applyAction(off, update(["topics", "/scan"], true));
    expect(on.disabledTopics).toEqual([]);
  });
});

describe("buildSettingsTree — save destination", () => {
  it("defaults to browser download when no folder has been picked this session", () => {
    // A directory's read-write grant lapses on every page load, so a folder is never the
    // active destination until the user re-picks it. The panel therefore mounts with no
    // folder name, and this is what the editor must show.
    const tree = buildSettingsTree(DEFAULT_CONFIG, [], noop, { canPickDir: true });
    expect(tree.nodes.saving?.fields?.saveDestination).toMatchObject({ value: "download" });
    // Auto-save is not even offered without a folder.
    expect(tree.nodes.saving?.fields?.autoSave).toBeUndefined();
    expect(tree.nodes.saving?.help).toContain("Choose a save folder");
  });

  it("offers the folder as the selected value once one is picked", () => {
    const tree = buildSettingsTree(DEFAULT_CONFIG, [], noop, {
      canPickDir: true,
      saveFolderName: "captures",
    });
    expect(tree.nodes.saving?.fields?.saveDestination).toMatchObject({ value: "current" });
    expect(tree.nodes.saving?.fields?.autoSave).toMatchObject({ input: "boolean", value: false });
  });

  it("says downloads are the only option where silent save is unavailable", () => {
    const tree = buildSettingsTree(DEFAULT_CONFIG, [], noop, { canPickDir: false });
    expect(tree.nodes.saving?.fields?.saveDestination).toMatchObject({
      value: "Browser download",
      readonly: true,
    });
  });
});

describe("buildSettingsTree", () => {
  it("emits a clip-cache node holding both fields", () => {
    const tree = buildSettingsTree(DEFAULT_CONFIG, [], noop);
    const cache = tree.nodes.cache;
    expect(cache?.label).toBe("Clip cache");
    expect(cache?.fields?.maxCacheMb).toMatchObject({ input: "number", value: 2048, min: 0 });
    expect(cache?.fields?.gapThresholdSec).toMatchObject({ input: "number", value: 10, min: 1 });
  });

  it("reflects the current config values", () => {
    const config: DvrConfig = { ...DEFAULT_CONFIG, maxCacheMb: 64, gapThresholdSec: 3 };
    const tree = buildSettingsTree(config, [], noop);
    expect(tree.nodes.cache?.fields?.maxCacheMb).toMatchObject({ value: 64 });
    expect(tree.nodes.cache?.fields?.gapThresholdSec).toMatchObject({ value: 3 });
  });

  it("leaves the general and topics nodes intact", () => {
    const topics = [{ name: "/scan", schemaName: "s", datatype: "s" }];
    const tree = buildSettingsTree(DEFAULT_CONFIG, topics, noop);
    expect(tree.nodes.general?.fields?.budgetValue).toMatchObject({
      label: "Lookback (seconds)",
      value: 60,
    });
    expect(tree.nodes.topics?.fields?.["/scan"]).toMatchObject({ input: "boolean", value: true });
  });
});
