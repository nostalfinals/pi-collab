import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateTail, type ExtensionAPI, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";

const waitParameters = Type.Object({
  timeout: Type.Number({ minimum: 0 }),
});

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
      const result = await collab.waitForCollaborator(params.timeout);
      switch (result.type) {
        case "timeout":
          return {
            content: [{ type: "text", text: text.model.waitTimeoutResult(params.timeout) }],
            details: {},
            isError: true,
          };

        case "reportQueued":
          return {
            content: [{ type: "text", text: text.model.waitReportQueuedResult }],
            details: {},
            isError: false,
          };

        case "interrupted":
          return {
            content: [{ type: "text", text: text.model.waitInterruptedResult }],
            details: {},
            isError: true,
          };

        case "aborted":
          return {
            content: [{ type: "text", text: text.model.waitAbortedResult }],
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

          const directory = await mkdtemp(join(tmpdir(), "pi-collab-"));
          const fullOutputPath = join(directory, "report.txt");
          await writeFile(fullOutputPath, outcome.report!, "utf8");

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
}
