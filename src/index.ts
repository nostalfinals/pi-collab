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

  // Let an aborted wait persist its tool result before Pi tears down the session.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (collab.hasPendingWait && !ctx.isIdle()) {
      const settled = new Promise<void>((resolve) => {
        const unsubscribe = pi.on("agent_settled", () => {
          unsubscribe();
          resolve();
        });
      });
      ctx.abort();
      await settled;
    }
    await collab.dispose();
  });
}
