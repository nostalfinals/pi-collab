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
    execute: async (_toolCallId, params) => {
      await collab.sendToCollaborator(params.message);
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
      const result = await collab.waitForCollaborator(params.timeout);
      switch (result.type) {
        case "timeout":
          return {
            content: [{ type: "text", text: text.model.waitTimeoutResult(params.timeout) }],
            details: {},
            isError: true,
          };
        case "interrupted":
          return {
            content: [{ type: "text", text: text.model.waitInterruptedResult }],
            details: {},
            isError: false,
          };
        case "report":
          return {
            content: [{ type: "text", text: text.model.waitResult(result.report) }],
            details: {},
          };
      }
    },
  });
}
