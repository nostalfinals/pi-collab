import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collabCommand } from "./command.ts";
import { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";
import { registerCollabTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
  const collab = new CollabMode(pi);
  registerCollabTools(pi, collab);

  pi.on("session_start", (_event, ctx) => {
    collab.extensionContext = ctx;
  });
  pi.on("session_shutdown", () => collab.dispose());

  pi.registerCommand("collab", {
    description: text.ui.collabCommandDescription,
    handler: async (_args, ctx) => collabCommand(collab, ctx),
  });
}
