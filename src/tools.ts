import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";

export function registerCollabTools(pi: ExtensionAPI, collab: CollabMode): void {
  pi.registerTool({
    name: "collab_send",
    label: text.ui.collabSendToolLabel,
    description: text.model.sendDescription,
    parameters: Type.Object({
      message: Type.String(),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      await collab.sendToCollaborator(ctx, params.message);
      return {
        content: [{ type: "text", text: text.model.sendResult }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "collab_wait",
    label: text.ui.collabWaitToolLabel,
    description: text.model.waitDescription,
    parameters: Type.Object({
      timeout: Type.Number({ minimum: 0 }),
    }),
    execute: async (_toolCallId, params) => {
      const report = await collab.waitForCollaborator(params.timeout);
      if (report === undefined) {
        return {
          content: [{ type: "text", text: text.model.waitTimeoutResult }],
          details: {},
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: text.model.waitResult(report) }],
        details: {},
      };
    },
  });
}
