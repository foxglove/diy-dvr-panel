import { ExtensionContext } from "@foxglove/extension";

import { initDvrPanel } from "./DvrPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "DIY DVR", initPanel: initDvrPanel });
}
