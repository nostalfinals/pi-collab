import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateTail, type ExtensionAPI, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";

const defaultWaitTimeout = 300;
const maxWaitTimeout = 1200;

const waitParameters = Type.Object({
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: maxWaitTimeout })),
});

const inspectParameters = Type.Object({
  count: Type.Optional(Type.Integer({ minimum: 1 })),
});

// Keeps the full text in a temp file so a truncated tool result can point to it.
async function writeFullOutput(content: string, name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-collab-"));
  const fullOutputPath = join(directory, name);
  await writeFile(fullOutputPath, content, "utf8");
  return fullOutputPath;
}

interface WaitDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

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
          const outcome = { state: result.state, report: result.report, error: result.error };
          const isError = outcome.state === "error";
          const truncation = outcome.report === undefined ? undefined : truncateTail(outcome.report);

          if (!truncation?.truncated) {
            return {
              content: [{ type: "text", text: text.model.collaboratorOutcome(outcome) }],
              details: {},
              isError,
            };
          }

          const fullOutputPath = await writeFullOutput(outcome.report!, "report.txt");

          return {
            content: [
              {
                type: "text",
                text: text.model.collaboratorOutcome({ ...outcome, report: truncation.content }, fullOutputPath),
              },
            ],
            details: { truncation, fullOutputPath },
            isError,
          };
        }
      }
    },
  });

  pi.registerTool<typeof inspectParameters, WaitDetails>({
    name: "collab_inspect",
    label: text.ui.collabInspectToolLabel,
    description: text.model.inspectDescription,
    parameters: inspectParameters,

    execute: async (_toolCallId, params) => {
      const inspection = await collab.inspectCollaborator(params.count ?? 5);
      const output = text.model.collaboratorActivity(inspection);
      const truncation = truncateTail(output);

      if (!truncation.truncated) {
        return { content: [{ type: "text", text: output }], details: {} };
      }

      const fullOutputPath = await writeFullOutput(output, "activity.txt");
      return {
        content: [{ type: "text", text: truncation.content + text.model.truncatedOutput(fullOutputPath) }],
        details: { truncation, fullOutputPath },
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
