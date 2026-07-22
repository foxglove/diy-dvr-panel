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
  Topic,
} from "@foxglove/extension";

export type BudgetMode = "time" | "bytes";

export type DvrConfig = {
  /** Allowlist is "all advertised topics minus these" — every topic defaults on. */
  disabledTopics: string[];
  budgetMode: BudgetMode;
  /** Seconds when mode === "time" (default 60); MB when mode === "bytes". */
  budgetValue: number;
  autoSave: boolean;
};

export const DEFAULT_CONFIG: DvrConfig = {
  disabledTopics: [],
  budgetMode: "time",
  budgetValue: 60,
  autoSave: false,
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
      value: !config.disabledTopics.includes(topic.name),
    };
  }
  return fields;
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

  const folderIsSet = opts?.saveFolderName != undefined;

  // Group the save-destination controls together: the Save folder display, the
  // Choose-folder affordance, and (only once a folder is set) Auto-save. Rendering
  // Auto-save without a folder would dump every rotation to the native download
  // dialog, so gate it on a folder being chosen.
  const savingFields: SettingsTreeFields = {
    saveFolder: {
      label: "Save folder",
      input: "string",
      value: opts?.saveFolderName ?? "Browser download",
      readonly: true,
    },
  };
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
    // The choose action lives on the Saving node so it renders next to the
    // Save-folder / Auto-save controls it relates to. Short single-line label so
    // it fits inline in the node header. The in-panel body offers the same picker.
    saving.actions = [
      { type: "action", id: "chooseSaveFolder", label: "Choose folder…", display: "inline" },
    ];
    if (!folderIsSet) {
      saving.help = "Set a save folder to enable auto-save.";
    }
  } else {
    saving.help =
      "Silent save requires a Chromium-based build (Chrome/Edge desktop or web). Files will download instead.";
  }

  const topicsNode: SettingsTreeNode = {
    label: "Topics",
    defaultExpansionState: "collapsed",
    fields: buildTopicsFields(config, topics),
  };

  return {
    nodes: {
      general,
      saving,
      topics: topicsNode,
    },
    actionHandler,
  };
}

/**
 * Apply a settings-editor action to a config, returning a new config object.
 * Returns the *same* reference when nothing changes so callers can cheaply skip
 * re-renders / persistence. Ignores non-`update` actions (button clicks and
 * reorder-children are handled by the panel, not here).
 */
export function applyAction(config: DvrConfig, action: SettingsTreeAction): DvrConfig {
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

  if (path[0] === "topics" && path.length >= 2) {
    const name = path[1];
    if (name == undefined) {
      return config;
    }
    const disabled = value === false;
    const isDisabled = config.disabledTopics.includes(name);
    if (disabled === isDisabled) {
      return config;
    }
    if (disabled) {
      return { ...config, disabledTopics: [...config.disabledTopics, name] };
    }
    return { ...config, disabledTopics: config.disabledTopics.filter((t) => t !== name) };
  }

  return config;
}
