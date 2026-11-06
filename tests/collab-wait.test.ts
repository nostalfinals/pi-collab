import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { CollabMode } from "../src/collab-mode.ts";
import { registerCollabTools } from "../src/tools.ts";

it("truncates reports over 50 KB and saves the full report", async () => {
  const report = "a".repeat(60 * 1024);
  let waitTool: ToolDefinition | undefined;

  const pi = {
    registerTool(tool: ToolDefinition): void {
      if (tool.name === "collab_wait") {
        waitTool = tool;
      }
    },
  } as unknown as ExtensionAPI;

  const collab = {
    waitForCollaborator: async () => ({ type: "settled", state: "completed", report }),
  } as unknown as CollabMode;

  registerCollabTools(pi, collab);

  if (!waitTool) {
    throw new Error("collab_wait was not registered");
  }

  const result = await waitTool.execute("call", { timeout: 1 }, undefined, undefined, {} as ExtensionToolContext);
  const details = result.details as { truncation?: TruncationResult; fullOutputPath?: string } | undefined;
  const output = result.content[0];

  expect(details?.truncation?.truncated).toBe(true);

  if (!details?.fullOutputPath) {
    throw new Error("Expected the full report path");
  }

  if (output?.type !== "text") {
    throw new Error("Expected a text tool result");
  }

  expect(output.text.length).toBeLessThan(report.length);

  const fullOutputPath = details.fullOutputPath;

  try {
    expect((await stat(fullOutputPath)).isFile()).toBe(true);
    expect(await readFile(fullOutputPath, "utf8")).toBe(report);
  } finally {
    await rm(dirname(fullOutputPath), { recursive: true, force: true });
  }
});
