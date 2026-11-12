import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CollabMode } from "./collab-mode.ts";
import type { CollaboratorOutcome } from "./types.ts";
import { text } from "./text.ts";
import { truncateText } from "./utils/truncation.ts";

const defaultReadTimeout = 300;
const maxReadTimeout = 1200;

export const collabToolNames = ["collab_send", "collab_read", "collab_inspect", "collab_interrupt"];

const readParameters = Type.Object({
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: maxReadTimeout })),
});

const inspectParameters = Type.Object({
  count: Type.Optional(Type.Integer({ minimum: 1 })),
});

type ReadDetails = { outcome?: CollaboratorOutcome };
type InspectResult = { fullOutputPath?: string };

export function registerCollabTools(pi: ExtensionAPI, collab: CollabMode): void {
  pi.registerTool({
    name: "collab_send",
    label: text.ui.collabSendToolLabel,
    description: text.model.sendDescription,
    parameters: Type.Object({
      message: Type.String(),
    }),
    // Sibling tool calls wait until the message is delivered, so a collab_read in the same batch
    // does not read the previous run.
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      await collab.sendToCollaborator(params.message);
      return {
        content: [{ type: "text", text: text.model.sendResult }],
        details: {},
      };
    },
  });

  pi.registerTool<typeof readParameters, ReadDetails>({
    name: "collab_read",
    label: text.ui.collabReadToolLabel,
    description: text.model.readDescription,
    parameters: readParameters,

    execute: async (_toolCallId, params) => {
      const timeout = params.timeout ?? defaultReadTimeout;
      const result = await collab.readCollaborator(timeout);
      switch (result.type) {
        case "timeout":
          return {
            content: [{ type: "text", text: text.model.readTimeoutResult(timeout) }],
            details: {},
            isError: true,
          };

        case "reportQueued":
          return {
            content: [{ type: "text", text: text.model.readReportQueuedResult }],
            details: {},
            isError: false,
          };

        case "interruptedByUser":
          return {
            content: [{ type: "text", text: text.model.readInterruptedByUserResult }],
            details: {},
            isError: true,
          };

        case "aborted":
          return {
            content: [{ type: "text", text: text.model.readAbortedResult }],
            details: {},
            isError: true,
          };

        case "collaboratorInterrupted":
          return {
            content: [{ type: "text", text: text.model.readCollaboratorInterruptedResult }],
            details: {},
            isError: true,
          };

        case "incomplete":
          return {
            content: [{ type: "text", text: text.model.readIncompleteResult(result.error) }],
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
      const truncation = await truncateText(output, "tail");

      if (!truncation) {
        return { content: [{ type: "text", text: output }], details: {} };
      }

      const { result, fullOutputPath } = truncation;
      return {
        content: [{ type: "text", text: result.content + text.model.truncatedOutput(fullOutputPath) }],
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
