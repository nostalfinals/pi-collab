import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CollabMode } from "../src/collab-mode.ts";
import { defaultCollaboratorConfig } from "../src/config.ts";
import extension from "../src/index.ts";

// The extension entry point loads collab.json from the agent directory.
const agentDir = mkdtempSync(join(tmpdir(), "pi-collab-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

const timestamp = "2026-01-01T00:00:00.000Z";

function status(id: string): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp,
    customType: "pi-collab/status",
    content: `status ${id}`,
    display: false,
  } as SessionEntry;
}

function message(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "user", content: id, timestamp: 0 },
  } as SessionEntry;
}

function compaction(id: string, firstKeptEntryId: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp,
    summary: "summary",
    firstKeptEntryId,
    tokensBefore: 0,
  } as SessionEntry;
}

function contextFor(branch: SessionEntry[]): ExtensionContext {
  return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

function lostStatusId(branch: SessionEntry[]): string | undefined {
  const collab = new CollabMode({} as ExtensionAPI, "", defaultCollaboratorConfig());
  collab.extensionContext = contextFor(branch);
  return collab.statusMessageLostInCompaction?.id;
}

describe("statusMessageLostInCompaction", () => {
  it("returns nothing when the branch has no compaction", () => {
    expect(lostStatusId([status("s1"), message("m1")])).toBeUndefined();
  });

  it("returns the last status message summarized by the compaction", () => {
    expect(lostStatusId([status("s1"), status("s2"), message("m1"), compaction("c1", "m1")])).toBe("s2");
  });

  it("returns nothing when the last status message is in the kept window", () => {
    expect(lostStatusId([status("s1"), message("m1"), status("s2"), compaction("c1", "m1")])).toBeUndefined();
  });

  it("returns nothing when no status message exists before the compaction", () => {
    expect(lostStatusId([message("m1"), message("m2"), compaction("c1", "m2")])).toBeUndefined();
  });

  it("ignores status messages added after the compaction", () => {
    expect(lostStatusId([message("m1"), compaction("c1", "m1"), status("s1")])).toBeUndefined();
  });

  it("returns nothing when the last status message is in the latest compaction's kept window", () => {
    expect(
      lostStatusId([status("s1"), message("m1"), compaction("c1", "m1"), status("s2"), compaction("c2", "s2")]),
    ).toBeUndefined();
  });

  it("returns the last status message summarized by the latest compaction", () => {
    expect(
      lostStatusId([
        status("s1"),
        message("m1"),
        compaction("c1", "m1"),
        status("s2"),
        message("m2"),
        compaction("c2", "m2"),
      ]),
    ).toBe("s2");
  });

  it("treats every earlier status message as summarized when the first kept entry is missing", () => {
    expect(lostStatusId([message("m1"), status("s1"), message("m2"), compaction("c1", "missing")])).toBe("s1");
  });
});

describe("context handler", () => {
  type ContextHandler = (event: { type: "context"; messages: AgentMessage[] }) => { messages: AgentMessage[] } | void;

  function setup(branch: SessionEntry[]): ContextHandler {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    extension(pi);
    void handlers.get("session_start")!({ type: "session_start", reason: "startup" }, contextFor(branch));
    return handlers.get("context") as ContextHandler;
  }

  const summary: AgentMessage = { role: "compactionSummary", summary: "summary", tokensBefore: 0, timestamp: 0 };
  const user: AgentMessage = { role: "user", content: "hello", timestamp: 0 };

  it("inserts the lost status message right after the compaction summary", () => {
    const handler = setup([status("s1"), message("m1"), compaction("c1", "m1")]);
    const result = handler({ type: "context", messages: [summary, user] });

    expect(result?.messages).toEqual([
      summary,
      {
        role: "custom",
        customType: "pi-collab/status",
        content: "status s1",
        display: false,
        timestamp: new Date(timestamp).getTime(),
      },
      user,
    ]);
  });

  it("leaves messages unchanged when the first message is not a compaction summary", () => {
    const handler = setup([status("s1"), message("m1"), compaction("c1", "m1")]);
    expect(handler({ type: "context", messages: [user] })).toBeUndefined();
  });

  it("leaves messages unchanged when no status message was lost", () => {
    const handler = setup([message("m1"), status("s1"), compaction("c1", "s1")]);
    expect(handler({ type: "context", messages: [summary, user] })).toBeUndefined();
  });
});
