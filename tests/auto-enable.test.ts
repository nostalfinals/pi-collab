import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import type { CollabConfig } from "../src/types.ts";
import { createCollab, FakeSession, stateEntry, type CollabCalls } from "./helpers.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

const config: CollabConfig = { provider: "p", modelId: "m", thinkingLevel: "off" };

function messageEntry(): SessionEntry {
  return {
    type: "message",
    id: "message",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello", timestamp: 0 },
  } as SessionEntry;
}

function emptyCalls(): CollabCalls {
  return { appendEntry: [], sendMessage: [], notify: [] };
}

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "pi-collab-auto-enable-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  rmSync(agentDir, { recursive: true, force: true });
});

describe("autoEnable", () => {
  it("enables collab mode with the default config in a new session", async () => {
    const calls = emptyCalls();
    const collab = await createCollab(new FakeSession(), {
      branch: [],
      loaded: false,
      model: { reasoning: true },
      calls,
    });

    await collab.autoEnable(config);

    expect(calls.appendEntry).toEqual([{ type: "pi-collab/state", data: { mode: "active", config } }]);
    expect(calls.sendMessage).toHaveLength(1);
    expect(calls.sendMessage[0]?.customType).toBe("pi-collab/status");
    expect(calls.notify).toEqual([]);
  });

  it("clamps the thinking level to one the model supports", async () => {
    const calls = emptyCalls();
    const collab = await createCollab(new FakeSession(), {
      branch: [],
      loaded: false,
      model: { reasoning: false },
      calls,
    });

    await collab.autoEnable({ ...config, thinkingLevel: "high" });

    expect(calls.appendEntry).toEqual([
      { type: "pi-collab/state", data: { mode: "active", config: { ...config, thinkingLevel: "off" } } },
    ]);
  });

  it("does nothing when the session already has a collab state", async () => {
    const calls = emptyCalls();
    const collab = await createCollab(new FakeSession(), {
      branch: [stateEntry("paused")],
      loaded: false,
      model: { reasoning: true },
      calls,
    });

    await collab.autoEnable(config);

    expect(calls).toEqual(emptyCalls());
  });

  it("does nothing when the session already has messages", async () => {
    const calls = emptyCalls();
    const collab = await createCollab(new FakeSession(), {
      branch: [messageEntry()],
      loaded: false,
      model: { reasoning: true },
      calls,
    });

    await collab.autoEnable(config);

    expect(calls).toEqual(emptyCalls());
  });

  it("warns and stays disabled when the model is not found", async () => {
    const calls = emptyCalls();
    const collab = await createCollab(new FakeSession(), {
      branch: [],
      loaded: false,
      model: undefined,
      calls,
    });

    await collab.autoEnable(config);

    expect(calls.notify).toHaveLength(1);
    expect(calls.notify[0]?.type).toBe("warning");
    expect(calls.notify[0]?.message).toContain("p/m");
    expect(calls.appendEntry).toEqual([]);
  });

  it("warns and stays disabled when the model has no authentication", async () => {
    const calls = emptyCalls();
    const collab = await createCollab(new FakeSession(), {
      branch: [],
      loaded: false,
      model: { reasoning: true },
      auth: false,
      calls,
    });

    await collab.autoEnable(config);

    expect(calls.notify).toHaveLength(1);
    expect(calls.notify[0]?.type).toBe("warning");
    expect(calls.appendEntry).toEqual([]);
  });
});

describe("session_start handler", () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

  function writeConfig(content: unknown): void {
    writeFileSync(join(agentDir, "collab.json"), JSON.stringify(content));
  }

  function contextFor(notify: CollabCalls["notify"]): ExtensionContext {
    return {
      isIdle: () => true,
      ui: {
        notify: (message: string, type: string | undefined) => {
          notify.push({ message, type });
        },
      },
      modelRegistry: { find: () => ({ reasoning: true }), hasConfiguredAuth: () => true },
      sessionManager: {
        getBranch: () => [],
        getSessionDir: () => agentDir,
        getSessionId: () => "lead",
      },
    } as unknown as ExtensionContext;
  }

  function loadExtension(calls: CollabCalls): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const pi = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler);
      },
      appendEntry: (type: string, data: unknown) => {
        calls.appendEntry.push({ type, data });
      },
      sendMessage: (message: Record<string, unknown>) => {
        calls.sendMessage.push(message);
      },
      getActiveTools: () => [],
    } as unknown as ExtensionAPI;

    extension(pi);
    return handlers;
  }

  async function runSessionStart(reason: string, collabConfig: unknown): Promise<CollabCalls> {
    writeConfig(collabConfig);
    const calls = emptyCalls();
    const handler = loadExtension(calls).get("session_start")!;
    await handler({ type: "session_start", reason }, contextFor(calls.notify));
    return calls;
  }

  const enabledConfig = { default: { model: "p/m", thinkingLevel: "off" }, autoEnable: true };

  it("auto-enables on startup and on a new session", async () => {
    for (const reason of ["startup", "new"]) {
      const calls = await runSessionStart(reason, enabledConfig);

      expect(calls.appendEntry).toEqual([{ type: "pi-collab/state", data: { mode: "active", config } }]);
    }
  });

  it("does not auto-enable on resume, fork, or reload", async () => {
    for (const reason of ["resume", "fork", "reload"]) {
      const calls = await runSessionStart(reason, enabledConfig);

      expect(calls).toEqual(emptyCalls());
    }
  });

  it("does not auto-enable when autoEnable is off", async () => {
    const calls = await runSessionStart("startup", { ...enabledConfig, autoEnable: false });

    expect(calls).toEqual(emptyCalls());
  });
});
