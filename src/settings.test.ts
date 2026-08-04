import { SettingsTreeAction } from "@foxglove/extension";

import {
  applyAction,
  buildSettingsTree,
  DEFAULT_CONFIG,
  DvrConfig,
  isGeneratedTopic,
  isTopicEnabled,
} from "./settings";

function update(path: string[], value: unknown): SettingsTreeAction {
  return { action: "update", payload: { path, value, input: "number" } } as SettingsTreeAction;
}

// buildSettingsTree only stores the handler on the returned tree; these tests never invoke it.
const noop = jest.fn();

function nodeAction(id: string, path: string[]): SettingsTreeAction {
  return { action: "perform-node-action", payload: { id, path } };
}

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

  it("still toggles a source topic off and on", () => {
    const off = applyAction(DEFAULT_CONFIG, update(["topics", "source", "/scan"], false));
    expect(off.disabledTopics).toEqual(["/scan"]);
    const on = applyAction(off, update(["topics", "source", "/scan"], true));
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
    expect(tree.nodes.topics?.children?.source?.fields?.["/scan"]).toMatchObject({
      input: "boolean",
      value: true,
    });
  });
});

describe("topic groups", () => {
  const topics = [
    { name: "/scan", schemaName: "s", datatype: "s" },
    { name: "/pose", schemaName: "s", datatype: "s" },
    { name: "/studio_script/pose_breadcrumbs", schemaName: "s", datatype: "s" },
    { name: "/studio_script/other", schemaName: "s", datatype: "s" },
  ];

  it("classifies topics by the user-script namespace", () => {
    expect(isGeneratedTopic("/studio_script/pose_breadcrumbs")).toBe(true);
    expect(isGeneratedTopic("/scan")).toBe(false);
    // Not a prefix match anywhere else in the name.
    expect(isGeneratedTopic("/robot/studio_script/x")).toBe(false);
  });

  it("puts each topic in its own group in the tree", () => {
    const tree = buildSettingsTree(DEFAULT_CONFIG, topics, noop);
    const source = tree.nodes.topics?.children?.source;
    const generated = tree.nodes.topics?.children?.generated;
    expect(Object.keys(source?.fields ?? {})).toEqual(["/scan", "/pose"]);
    expect(Object.keys(generated?.fields ?? {})).toEqual([
      "/studio_script/pose_breadcrumbs",
      "/studio_script/other",
    ]);
    // Both groups offer the enable-all / disable-all menu.
    for (const node of [source, generated]) {
      expect(node?.actions).toEqual([
        { type: "action", id: "all-on", label: "Enable all", display: "menu" },
        { type: "action", id: "all-off", label: "Disable all", display: "menu" },
      ]);
    }
  });

  it("captures source topics by default and generated topics not at all", () => {
    // A generated topic that republishes a growing history would otherwise inflate every
    // clip without the user ever asking for it.
    expect(isTopicEnabled(DEFAULT_CONFIG, "/scan")).toBe(true);
    expect(isTopicEnabled(DEFAULT_CONFIG, "/studio_script/pose_breadcrumbs")).toBe(false);

    const tree = buildSettingsTree(DEFAULT_CONFIG, topics, noop);
    expect(tree.nodes.topics?.children?.source?.fields?.["/scan"]).toMatchObject({ value: true });
    expect(
      tree.nodes.topics?.children?.generated?.fields?.["/studio_script/pose_breadcrumbs"],
    ).toMatchObject({ value: false });
  });

  it("keeps a generated topic off when it first appears, even after others were enabled", () => {
    const enabled = applyAction(
      DEFAULT_CONFIG,
      update(["topics", "generated", "/studio_script/other"], true),
      topics,
    );
    expect(isTopicEnabled(enabled, "/studio_script/other")).toBe(true);
    // A generated topic the user has never seen is still not captured.
    expect(isTopicEnabled(enabled, "/studio_script/brand_new")).toBe(false);
  });

  it("toggles a generated topic through its own allowlist", () => {
    const on = applyAction(
      DEFAULT_CONFIG,
      update(["topics", "generated", "/studio_script/other"], true),
      topics,
    );
    expect(on.enabledGeneratedTopics).toEqual(["/studio_script/other"]);
    expect(on.disabledTopics).toEqual([]);
    const off = applyAction(
      on,
      update(["topics", "generated", "/studio_script/other"], false),
      topics,
    );
    expect(off.enabledGeneratedTopics).toEqual([]);
  });

  it("enables and disables a whole group from the node menu", () => {
    const allGenerated = applyAction(
      DEFAULT_CONFIG,
      nodeAction("all-on", ["topics", "generated"]),
      topics,
    );
    expect(allGenerated.enabledGeneratedTopics.sort()).toEqual([
      "/studio_script/other",
      "/studio_script/pose_breadcrumbs",
    ]);
    // Source is untouched by the generated group's action.
    expect(allGenerated.disabledTopics).toEqual([]);

    const noSource = applyAction(allGenerated, nodeAction("all-off", ["topics", "source"]), topics);
    expect(noSource.disabledTopics.sort()).toEqual(["/pose", "/scan"]);
    expect(isTopicEnabled(noSource, "/scan")).toBe(false);

    const backOn = applyAction(noSource, nodeAction("all-on", ["topics", "source"]), topics);
    expect(backOn.disabledTopics).toEqual([]);

    const noGenerated = applyAction(backOn, nodeAction("all-off", ["topics", "generated"]), topics);
    expect(noGenerated.enabledGeneratedTopics).toEqual([]);
  });

  it("returns the same reference when a group action changes nothing", () => {
    // Source already all on; generated already all off.
    expect(applyAction(DEFAULT_CONFIG, nodeAction("all-on", ["topics", "source"]), topics)).toBe(
      DEFAULT_CONFIG,
    );
    expect(
      applyAction(DEFAULT_CONFIG, nodeAction("all-off", ["topics", "generated"]), topics),
    ).toBe(DEFAULT_CONFIG);
  });

  it("leaves choices about topics that are not currently advertised alone", () => {
    // The user switched /gone off while it existed; enabling everything now should not
    // silently re-enable it, because it is not in the advertised list.
    const config: DvrConfig = { ...DEFAULT_CONFIG, disabledTopics: ["/gone", "/scan"] };
    const next = applyAction(config, nodeAction("all-on", ["topics", "source"]), topics);
    expect(next.disabledTopics).toEqual(["/gone"]);
  });

  it("ignores unknown groups and unknown node actions", () => {
    expect(applyAction(DEFAULT_CONFIG, nodeAction("all-on", ["topics", "nope"]), topics)).toBe(
      DEFAULT_CONFIG,
    );
    expect(applyAction(DEFAULT_CONFIG, nodeAction("explode", ["topics", "source"]), topics)).toBe(
      DEFAULT_CONFIG,
    );
    expect(applyAction(DEFAULT_CONFIG, nodeAction("all-on", ["general"]), topics)).toBe(
      DEFAULT_CONFIG,
    );
  });
});
