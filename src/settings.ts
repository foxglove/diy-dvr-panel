// Panel configuration + settings-tree builder for the DIY DVR panel.
//
// Kept intentionally pure (no `PanelExtensionContext` references) so the config
// and action logic is trivially unit-testable and re-usable. The panel owns the
// `context` wiring (persistence, worker plumbing); this module only shapes the
// settings tree and applies actions to a plain config object.

import {
  SettingsTree,
  SettingsTreeAction,
  SettingsTreeField,
  SettingsTreeFields,
  SettingsTreeNode,
  SettingsTreeNodeAction,
  Topic,
} from "@foxglove/extension";

export type BudgetMode = "time" | "bytes";

/**
 * Topics under this prefix come from the app's user scripts rather than the data source.
 *
 * `Topic` carries no flag distinguishing the two, so the namespace is the signal. They are
 * excluded from capture by default: a script that republishes an accumulating history keeps a
 * flat message count while its payload grows without bound, which quietly inflates every clip.
 */
export const GENERATED_TOPIC_PREFIX = "/studio_script/";

export function isGeneratedTopic(name: string): boolean {
  return name.startsWith(GENERATED_TOPIC_PREFIX);
}

/** Whether a topic is captured, given the two opposite defaults. */
export function isTopicEnabled(config: DvrConfig, name: string): boolean {
  if (isGeneratedTopic(name)) {
    return config.enabledGeneratedTopics.includes(name);
  }
  return !config.disabledTopics.includes(name);
}

export type DvrConfig = {
  /** Source topics: "all advertised topics minus these" — every source topic defaults on. */
  disabledTopics: string[];
  /**
   * Generated topics: the opposite default. Only the ones listed here are captured, so a
   * newly-appearing generated topic stays off until the user asks for it.
   */
  enabledGeneratedTopics: string[];
  budgetMode: BudgetMode;
  /** Seconds when mode === "time" (default 60); MB when mode === "bytes". */
  budgetValue: number;
  autoSave: boolean;
  /**
   * Total cap on the durable clip cache, in MB. Oldest whole clips are dropped first.
   * Defaults high (2 GB) because a single clip off a busy stream can be hundreds of MB.
   */
  maxCacheMb: number;
  /** Seconds without any message that trigger a "gap" clip. 0 disables the trigger. */
  gapThresholdSec: number;
};

export const DEFAULT_CONFIG: DvrConfig = {
  disabledTopics: [],
  enabledGeneratedTopics: [],
  budgetMode: "time",
  budgetValue: 60,
  autoSave: false,
  maxCacheMb: 2048,
  gapThresholdSec: 10,
};

/** Options describing the (session-only) silent-save destination for the editor. */
export type SettingsTreeOpts = {
  canPickDir: boolean;
  saveFolderName?: string;
};

function budgetValueLabel(mode: BudgetMode): string {
  if (mode === "time") {
    return "Lookback (seconds)";
  }
  return "Budget (MB)";
}

function buildTopicsFields(config: DvrConfig, topics: readonly Topic[]): SettingsTreeFields {
  const fields: Record<string, SettingsTreeField> = {};
  for (const topic of topics) {
    fields[topic.name] = {
      label: topic.name,
      input: "boolean",
      value: isTopicEnabled(config, topic.name),
    };
  }
  return fields;
}

/** Enable-all / disable-all for a whole topic group, in the node's overflow menu. */
const TOPIC_GROUP_ACTIONS: SettingsTreeNodeAction[] = [
  { type: "action", id: "all-on", label: "Enable all", display: "menu" },
  { type: "action", id: "all-off", label: "Disable all", display: "menu" },
];

function splitTopics(topics: readonly Topic[]): {
  source: readonly Topic[];
  generated: readonly Topic[];
} {
  return {
    source: topics.filter((topic) => !isGeneratedTopic(topic.name)),
    generated: topics.filter((topic) => isGeneratedTopic(topic.name)),
  };
}

export function buildSettingsTree(
  config: DvrConfig,
  topics: readonly Topic[],
  actionHandler: (action: SettingsTreeAction) => void,
  opts?: SettingsTreeOpts,
): SettingsTree {
  const general: SettingsTreeNode = {
    label: "General",
    fields: {
      budgetMode: {
        label: "Budget mode",
        input: "select",
        value: config.budgetMode,
        options: [
          { label: "Time (seconds)", value: "time" },
          { label: "Size (MB)", value: "bytes" },
        ],
      },
      budgetValue: {
        label: budgetValueLabel(config.budgetMode),
        input: "number",
        value: config.budgetValue,
        min: 0,
      },
    },
  };

  const folderName = opts?.saveFolderName;
  const folderIsSet = folderName != undefined;

  // Group the save-destination controls together: the "Save destination" picker
  // field, and (only once a folder is set) Auto-save. Rendering Auto-save without a
  // folder would dump every rotation to the native download dialog, so gate it on a
  // folder being chosen.
  const savingFields: SettingsTreeFields = {};

  if (opts?.canPickDir === true) {
    // A settings-field change is a user gesture, so the panel opens the directory
    // picker (and requests write permission) from the "choose" update under
    // transient activation. When a folder is set it is shown as the selected value.
    const destinationOptions = folderIsSet
      ? [
          { label: folderName, value: "current" },
          { label: "Choose folder…", value: "choose" },
          { label: "Browser download", value: "download" },
        ]
      : [
          { label: "Browser download", value: "download" },
          { label: "Choose folder…", value: "choose" },
        ];
    savingFields.saveDestination = {
      label: "Save destination",
      input: "select",
      value: folderIsSet ? "current" : "download",
      options: destinationOptions,
    };
  } else {
    savingFields.saveDestination = {
      label: "Save destination",
      input: "string",
      value: "Browser download",
      readonly: true,
    };
  }

  if (folderIsSet) {
    savingFields.autoSave = {
      label: "Auto-save on rotation",
      input: "boolean",
      value: config.autoSave,
    };
  }

  const saving: SettingsTreeNode = {
    label: "Saving",
    fields: savingFields,
  };

  if (opts?.canPickDir === true) {
    if (!folderIsSet) {
      saving.help = "Choose a save folder to enable silent save and auto-save.";
    }
  } else {
    saving.help =
      "Silent save requires a Chromium-based build (Chrome/Edge desktop or web). Files will download instead.";
  }

  // The durable clip cache: event-triggered snapshots are written to browser storage
  // (OPFS) so they outlive a panel remount / worker teardown, bounded by a byte cap.
  const cache: SettingsTreeNode = {
    label: "Clip cache",
    fields: {
      maxCacheMb: {
        label: "Cache limit (MB)",
        input: "number",
        value: config.maxCacheMb,
        min: 0,
      },
      gapThresholdSec: {
        label: "Gap trigger (seconds)",
        input: "number",
        value: config.gapThresholdSec,
        min: 1,
      },
    },
    help:
      "Clips are captured on a connection gap, when the tab is hidden, and on close, and " +
      "survive a reconnect. The oldest clips are dropped when the cache limit is exceeded. " +
      "Clips are held in browser storage, so the default 2 GB counts against this origin's " +
      "storage quota — lower it if you are short on disk, or if the browser starts evicting " +
      "storage on its own.",
  };

  // Two groups rather than one flat list, because the two halves have opposite defaults and
  // very different risk: a generated topic can grow without bound.
  const { source, generated } = splitTopics(topics);
  const topicsNode: SettingsTreeNode = {
    label: "Topics",
    defaultExpansionState: "collapsed",
    children: {
      source: {
        label: "Source",
        actions: TOPIC_GROUP_ACTIONS,
        fields: buildTopicsFields(config, source),
      },
      generated: {
        label: "Generated",
        actions: TOPIC_GROUP_ACTIONS,
        help:
          "Topics produced by user scripts. Off by default: a script that republishes a " +
          "growing history keeps a flat message count while its payload keeps expanding, " +
          "which inflates every clip.",
        fields: buildTopicsFields(config, generated),
      },
    },
  };

  return {
    nodes: {
      general,
      saving,
      cache,
      topics: topicsNode,
    },
    actionHandler,
  };
}

/**
 * Coerce a settings-editor number field, clamped at zero. Returns `undefined` when the
 * value is unusable or unchanged, so the caller can keep the current config reference.
 */
function numericUpdate(value: unknown, current: number): number | undefined {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  const next = Math.max(0, parsed);
  if (next === current) {
    return undefined;
  }
  return next;
}

/** Turn one topic on or off, honouring which list governs its group. */
function setTopicEnabled(config: DvrConfig, name: string, state: "on" | "off"): DvrConfig {
  const enabled = state === "on";
  if (isTopicEnabled(config, name) === enabled) {
    return config;
  }
  if (isGeneratedTopic(name)) {
    // Governed by an allowlist, so enabling adds and disabling removes.
    return {
      ...config,
      enabledGeneratedTopics: enabled
        ? [...config.enabledGeneratedTopics, name]
        : config.enabledGeneratedTopics.filter((topic) => topic !== name),
    };
  }
  return {
    ...config,
    disabledTopics: enabled
      ? config.disabledTopics.filter((topic) => topic !== name)
      : [...config.disabledTopics, name],
  };
}

/**
 * Add or remove `names` from `list`, or `undefined` when the membership already matches.
 *
 * Only currently-advertised topics are passed in, so a topic the user switched off while it
 * was present keeps that choice while it is absent from the source.
 */
function updateMembership(
  list: readonly string[],
  names: readonly string[],
  operation: "add" | "remove",
): string[] | undefined {
  const next = new Set(list);
  const before = next.size;
  for (const name of names) {
    if (operation === "add") {
      next.add(name);
    } else {
      next.delete(name);
    }
  }
  return next.size === before ? undefined : Array.from(next);
}

/** The "Enable all" / "Disable all" items in a topic group's overflow menu. */
function applyNodeAction(
  config: DvrConfig,
  payload: { id: string; path: readonly string[] },
  topics: readonly Topic[],
): DvrConfig {
  if (payload.path[0] !== "topics") {
    return config;
  }
  const group = payload.path[1];
  if (payload.id !== "all-on" && payload.id !== "all-off") {
    return config;
  }
  const enable = payload.id === "all-on";
  const { source, generated } = splitTopics(topics);

  if (group === "generated") {
    const names = generated.map((topic) => topic.name);
    const next = updateMembership(config.enabledGeneratedTopics, names, enable ? "add" : "remove");
    return next == undefined ? config : { ...config, enabledGeneratedTopics: next };
  }
  if (group === "source") {
    const names = source.map((topic) => topic.name);
    const next = updateMembership(config.disabledTopics, names, enable ? "remove" : "add");
    return next == undefined ? config : { ...config, disabledTopics: next };
  }
  return config;
}

/**
 * Apply a settings-editor action to a config, returning a new config object.
 * Returns the *same* reference when nothing changes so callers can cheaply skip
 * re-renders / persistence. Ignores non-`update` actions (button clicks and
 * reorder-children are handled by the panel, not here).
 */
export function applyAction(
  config: DvrConfig,
  action: SettingsTreeAction,
  topics: readonly Topic[] = [],
): DvrConfig {
  if (action.action === "perform-node-action") {
    return applyNodeAction(config, action.payload, topics);
  }
  if (action.action !== "update") {
    return config;
  }
  const path = action.payload.path;
  const value = action.payload.value;

  if (path[0] === "general") {
    if (path[1] === "budgetMode") {
      const mode = value as BudgetMode;
      if (mode === config.budgetMode) {
        return config;
      }
      return { ...config, budgetMode: mode };
    }
    if (path[1] === "budgetValue") {
      const next = Number(value);
      if (Number.isNaN(next) || next === config.budgetValue) {
        return config;
      }
      return { ...config, budgetValue: next };
    }
    return config;
  }

  if (path[0] === "saving") {
    if (path[1] === "autoSave") {
      const next = Boolean(value);
      if (next === config.autoSave) {
        return config;
      }
      return { ...config, autoSave: next };
    }
    return config;
  }

  if (path[0] === "cache") {
    if (path[1] === "maxCacheMb") {
      const next = numericUpdate(value, config.maxCacheMb);
      if (next == undefined) {
        return config;
      }
      return { ...config, maxCacheMb: next };
    }
    if (path[1] === "gapThresholdSec") {
      const next = numericUpdate(value, config.gapThresholdSec);
      if (next == undefined) {
        return config;
      }
      return { ...config, gapThresholdSec: next };
    }
    return config;
  }

  // ["topics", "source" | "generated", <topic name>]
  if (path[0] === "topics" && path.length >= 3) {
    const name = path[2];
    if (name == undefined) {
      return config;
    }
    return setTopicEnabled(config, name, value === false ? "off" : "on");
  }

  return config;
}
