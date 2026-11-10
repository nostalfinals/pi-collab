import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CollabMode, CollaboratorOutcome } from "./collab-mode.ts";
import { text } from "./text.ts";
import { truncateText } from "./truncation.ts";

const defaultWaitTimeout = 300;
const maxWaitTimeout = 1200;

const waitParameters = Type.Object({
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: maxWaitTimeout })),
});

const inspectParameters = Type.Object({
  count: Type.Optional(Type.Integer({ minimum: 1 })),
});

type WaitDetails = { outcome?: CollaboratorOutcome };
type InspectResult = { fullOutputPath?: string };

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

  pi.registerTool<typeof waitParameters, WaitDetails>({
    name: "collab_wait",
    label: text.ui.collabWaitToolLabel,
    description: text.model.waitDescription,
    parameters: waitParameters,

    execute: async (_toolCallId, params) => {
      const timeout = params.timeout ?? defaultWaitTimeout;
      const result = await collab.waitForCollaborator(timeout);
      switch (result.type) {
        case "timeout":
          return {
            content: [{ type: "text", text: text.model.waitTimeoutResult(timeout) }],
            details: {},
            isError: true,
          };

        case "reportQueued":
          return {
            content: [{ type: "text", text: text.model.waitReportQueuedResult }],
            details: {},
            isError: false,
          };

        case "interruptedByUser":
          return {
            content: [{ type: "text", text: text.model.waitInterruptedByUserResult }],
            details: {},
            isError: true,
          };

        case "aborted":
          return {
            content: [{ type: "text", text: text.model.waitAbortedResult }],
            details: {},
            isError: true,
          };

        case "collaboratorInterrupted":
          return {
            content: [{ type: "text", text: text.model.waitCollaboratorInterruptedResult }],
            details: {},
            isError: true,
          };

        case "settled": {
          const outcome = result.outcome;
          return {
            content: [
              {
                type: "text",
                text: text.model.collaboratorOutcome(result.outcome),
              },
            ],
            details: { outcome },
            isError: outcome.type === "error",
          };
        }
      }
    },
  });

  pi.registerTool<typeof inspectParameters, InspectResult>({
    name: "collab_inspect",
    label: text.ui.collabInspectToolLabel,
    description: text.model.inspectDescription,
    parameters: inspectParameters,

    execute: async (_toolCallId, params) => {
      const inspection = await collab.inspectCollaborator(params.count ?? 5);
      const output = text.model.collaboratorActivity(inspection);
      const truncation = await truncateText(output);

      if (!truncation) {
        return { content: [{ type: "text", text: output }], details: {} };
      }

      const { truncated, fullOutputPath } = truncation;
      return {
        content: [{ type: "text", text: truncated + text.model.truncatedOutput(fullOutputPath) }],
        details: { fullOutputPath },
      };
    },
  });

  pi.registerTool({
    name: "collab_interrupt",
    label: text.ui.collabInterruptToolLabel,
    description: text.model.interruptDescription,
    parameters: Type.Object({}),
    execute: async () => {
      await collab.interruptCollaborator();
      return {
        content: [{ type: "text", text: text.model.interruptResult }],
        details: {},
      };
    },
  });
}
