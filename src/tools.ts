import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";

export function registerCollabTools(pi: ExtensionAPI, collab: CollabMode): void {
  pi.registerTool({
    name: "collab_send",
    label: "SEND TOOL LABLE",
    description: "Send a message or steer the collaborator.",
    parameters: Type.Object({
      message: Type.String(),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      await collab.sendToCollaborator(ctx, params.message);
      return {
        content: [{ type: "text", text: "Message sent" }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "collab_wait",
    label: "WAIT TOOL LABLE",
    description: "Wait the collaborator to be settled, you will receive the collaborator's final message as tool result.",
    parameters: Type.Object({
      timeout: Type.Number({ minimum: 0 }),
    }),
    execute: async (_toolCallId, params) => {
      const report = await collab.waitForCollaborator(params.timeout);
      if (report === undefined) {
        return {
          content: [{ type: "text", text: `Collaborator didn't finish in ${params.timeout}` }],
          details: {},
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: wrapCollaboratorReport(report) }],
        details: {},
      };
    },
  });
}

function wrapCollaboratorReport(report: string): string {
  return `<report_from_collaborator>${report}</report_from_collaborator>`
}
