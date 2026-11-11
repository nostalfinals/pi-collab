import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { CollabMode } from "../src/collab-mode.ts";
import type { CollaboratorActivity } from "../src/types.ts";
import { registerCollabTools } from "../src/tools.ts";
import { anchorEntry, stateEntry } from "./helpers.ts";

type FakeSession = {
  isIdle: boolean;
  state: {
    messages: unknown[];
    streamingMessage?: unknown;
    pendingToolCalls: Set<string>;
  };
};

type CollabInternals = {
  collaboratorSession: Promise<FakeSession> | undefined;
  getOrCreateCollaborator: () => Promise<FakeSession>;
};

function assistant(...content: unknown[]): unknown {
  return { role: "assistant", content };
}

function textBlock(text: string): unknown {
  return { type: "text", text };
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

function fakeSession(state: Partial<FakeSession["state"]> = {}, isIdle = false): FakeSession {
  return { isIdle, state: { messages: [], pendingToolCalls: new Set(), ...state } };
}

function createCollab(branch: SessionEntry[], session?: FakeSession): CollabMode {
  const collab = new CollabMode({} as ExtensionAPI, "");
  collab.extensionContext = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  if (session) {
    (collab as unknown as CollabInternals).collaboratorSession = Promise.resolve(session);
  }
  return collab;
}

async function inspect(session: FakeSession, count = 100): Promise<CollaboratorActivity[]> {
  const collab = createCollab([stateEntry("active")], session);
  return (await collab.inspectCollaborator(count)).activities;
}

describe("inspectCollaborator", () => {
  it("collects text blocks and tool calls from assistant messages, oldest first", async () => {
    const activities = await inspect(
      fakeSession({
        messages: [
          assistant(textBlock("first"), toolCall("a", "read", { path: "x" })),
          assistant(toolCall("b", "bash", { command: "ls" }), textBlock("last")),
        ],
      }),
    );

    expect(activities).toEqual([
      { type: "text", text: "first", status: undefined },
      { type: "toolCall", name: "read", arguments: '{"path":"x"}', truncated: false, status: undefined },
      { type: "toolCall", name: "bash", arguments: '{"command":"ls"}', truncated: false, status: undefined },
      { type: "text", text: "last", status: undefined },
    ]);
  });

  it("skips thinking blocks, blank text, tool results, and non-assistant messages", async () => {
    const activities = await inspect(
      fakeSession({
        messages: [
          { role: "user", content: "task" },
          assistant({ type: "thinking", thinking: "hmm" }, textBlock("  \n"), toolCall("a", "read")),
          { role: "toolResult", toolCallId: "a", toolName: "read", content: [textBlock("result")] },
          { role: "custom", customType: "note", content: "note" },
        ],
      }),
    );

    expect(activities.map((activity) => activity.type)).toEqual(["toolCall"]);
  });

  it("returns only the last count activities", async () => {
    const activities = await inspect(
      fakeSession({ messages: [assistant(textBlock("1"), textBlock("2"), textBlock("3"))] }),
      2,
    );

    expect(activities.map((activity) => activity.type === "text" && activity.text)).toEqual(["2", "3"]);
  });

  it("truncates tool arguments over 500 characters and marks them truncated", async () => {
    const [short, long] = await inspect(
      fakeSession({
        messages: [
          assistant(toolCall("a", "write", { content: "a" }), toolCall("b", "write", { content: "b".repeat(600) })),
        ],
      }),
    );

    expect(short).toMatchObject({ truncated: false, arguments: '{"content":"a"}' });
    expect(long).toMatchObject({ truncated: true });
    expect(long?.type === "toolCall" && long.arguments).toBe(
      JSON.stringify({ content: "b".repeat(600) }).slice(0, 500),
    );
  });

  it("marks every activity in the streaming message as generating", async () => {
    const activities = await inspect(
      fakeSession({
        messages: [assistant(textBlock("done"))],
        streamingMessage: assistant(textBlock("writing"), toolCall("a", "edit")),
        pendingToolCalls: new Set(["a"]),
      }),
    );

    expect(activities.map((activity) => (activity.type === "error" ? undefined : activity.status))).toEqual([
      undefined,
      "generating",
      "generating",
    ]);
  });

  it("marks executing tool calls as running", async () => {
    const activities = await inspect(
      fakeSession({
        messages: [assistant(toolCall("a", "bash"), toolCall("b", "read"))],
        pendingToolCalls: new Set(["a"]),
      }),
    );

    expect(activities.map((activity) => (activity.type === "error" ? undefined : activity.status))).toEqual([
      "running",
      undefined,
    ]);
  });

  it("reports the collaborator as idle or running", async () => {
    const idle = createCollab([stateEntry("active")], fakeSession({}, true));
    const running = createCollab([stateEntry("active")], fakeSession({}, false));

    expect((await idle.inspectCollaborator(5)).status).toBe("idle");
    expect((await running.inspectCollaborator(5)).status).toBe("running");
  });

  it("works while collab mode is paused", async () => {
    const collab = createCollab([stateEntry("paused")], fakeSession({ messages: [assistant(textBlock("hi"))] }));
    expect((await collab.inspectCollaborator(5)).activities).toHaveLength(1);
  });

  it("throws when collab mode was never enabled", async () => {
    const collab = createCollab([], fakeSession());
    await expect(collab.inspectCollaborator(5)).rejects.toThrow();
  });

  it("throws when no collaborator exists on the branch", async () => {
    const collab = createCollab([stateEntry("active")]);
    await expect(collab.inspectCollaborator(5)).rejects.toThrow();
  });

  it("loads the collaborator when the branch has an anchor but no session is loaded", async () => {
    const collab = createCollab([stateEntry("active"), anchorEntry]);
    let loads = 0;
    (collab as unknown as CollabInternals).getOrCreateCollaborator = async () => {
      loads++;
      return fakeSession({ messages: [assistant(textBlock("restored"))] }, true);
    };

    const inspection = await collab.inspectCollaborator(5);

    expect(loads).toBe(1);
    expect(inspection.activities).toEqual([{ type: "text", text: "restored", status: undefined }]);
  });
});

describe("collab_inspect", () => {
  it("truncates large output and saves the full output to a file", async () => {
    let inspectTool: ToolDefinition | undefined;
    const pi = {
      registerTool(tool: ToolDefinition): void {
        if (tool.name === "collab_inspect") {
          inspectTool = tool;
        }
      },
    } as unknown as ExtensionAPI;
    const collab = {
      inspectCollaborator: async () => ({
        status: "idle",
        activities: [{ type: "text", text: "a".repeat(60 * 1024), status: undefined }],
      }),
    } as unknown as CollabMode;

    registerCollabTools(pi, collab);

    if (!inspectTool) {
      throw new Error("collab_inspect was not registered");
    }

    const result = await inspectTool.execute("call", {}, undefined, undefined, {} as ExtensionToolContext);
    const details = result.details as { fullOutputPath?: string } | undefined;
    const output = result.content[0];

    if (!details?.fullOutputPath) {
      throw new Error("Expected the full output path");
    }

    if (output?.type !== "text") {
      throw new Error("Expected a text tool result");
    }

    const fullOutputPath = details.fullOutputPath;

    try {
      const fullOutput = await readFile(fullOutputPath, "utf8");
      expect((await stat(fullOutputPath)).isFile()).toBe(true);
      expect(fullOutput).toContain("a".repeat(60 * 1024));
      expect(output.text.length).toBeLessThan(fullOutput.length);
    } finally {
      await rm(dirname(fullOutputPath), { recursive: true, force: true });
    }
  });
});
