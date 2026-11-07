import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collabCommand } from "./command.ts";
import { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";
import { registerCollabTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
  const collab = new CollabMode(pi, fileURLToPath(import.meta.url));

  registerCollabTools(pi, collab);

  pi.on("resources_discover", () => ({
    skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "../skills/collab-mode")],
  }));

  pi.registerCommand("collab", {
    description: text.ui.collabCommandDescription,
    handler: async (_args, ctx) => collabCommand(collab, ctx),
  });

  // Always present and state-neutral, so turning collab mode on or off never changes the system prompt.
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.collab_reminder = text.prompt.leadSection;
  });

  pi.on("session_start", async (event, ctx) => {
    collab.extensionContext = ctx;
    if (event.reason === "fork" && event.previousSessionFile) {
      await collab.copyCollaboratorForFork(event.previousSessionFile);
    }
  });

  pi.on("context", (event) => {
    const [summary, ...rest] = event.messages;
    if (summary?.role !== "compactionSummary") {
      return;
    }
    const status = collab.statusMessageLostInCompaction;
    if (!status) {
      return;
    }
    return {
      messages: [
        summary,
        {
          role: "custom",
          customType: status.customType,
          content: status.content,
          display: status.display,
          timestamp: new Date(status.timestamp).getTime(),
        },
        ...rest,
      ],
    };
  });

  pi.on("session_tree", async (_event, ctx) => {
    collab.extensionContext = ctx;
    await collab.syncBranch();
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

  pi.on("message_start", (event) => {
    if (event.message.role === "custom") {
      collab.handleLeadMessageStart(event.message.customType);
    }
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
