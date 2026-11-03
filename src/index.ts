import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collabCommand } from "./command.ts";
import { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";
import { registerCollabTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
  const collab = new CollabMode(pi, fileURLToPath(import.meta.url));

  registerCollabTools(pi, collab);

  pi.registerCommand("collab", {
    description: text.ui.collabCommandDescription,
    handler: async (_args, ctx) => collabCommand(collab, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    collab.extensionContext = ctx;
  });

  pi.on("agent_start", (_event, ctx) => {
    ctx.signal?.addEventListener(
      "abort",
      () => {
        void collab.abortCollaborator().catch((error: unknown) => {
          console.error("Failed to abort collaborator.", error);
        });
      },
      { once: true },
    );
  });

  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer") {
      void collab.interruptWaitAfterInput();
    }
  });

  pi.on("session_shutdown", () => collab.dispose());
}
