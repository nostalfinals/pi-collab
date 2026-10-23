import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collabCommand } from "./command.ts";
import { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";

export default function (pi: ExtensionAPI) {
  const collab = new CollabMode(pi);

  pi.registerCommand("collab", {
    description: text.ui.collabCommandDescription,
    handler: async (_args, ctx) => collabCommand(collab, ctx),
  });
}
