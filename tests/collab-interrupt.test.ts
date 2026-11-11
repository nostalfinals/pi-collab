import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CollabMode } from "../src/collab-mode.ts";

// Mirrors the parts of AgentSession that CollabMode touches. abort() follows pi's order:
// the session becomes idle first, then agent_settled is emitted with aborted: true.
class FakeSession {
  isIdle = false;
  isStreaming = true;
  clearedQueue = false;
  aborted = false;
  private listener: (event: AgentSessionEvent) => void = () => {};

  async bindExtensions(): Promise<void> {}

  subscribe(listener: (event: AgentSessionEvent) => void): void {
    this.listener = listener;
  }

  clearQueue(): void {
    this.clearedQueue = true;
  }

  async abort(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.aborted = true;
    this.isIdle = true;
    this.isStreaming = false;
    this.listener({ type: "agent_settled", aborted: true } as AgentSessionEvent);
  }
}

let currentSession: FakeSession;

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAgentSession: async () => ({ session: currentSession }),
  DefaultResourceLoader: class {
    async reload(): Promise<void> {}
  },
  SessionManager: { create: () => ({ resetLeaf() {} }) },
}));

type CollabInternals = {
  getOrCreateCollaborator: (config: unknown) => Promise<FakeSession>;
};

function stateEntry(mode: "active" | "paused"): SessionEntry {
  return {
    type: "custom",
    id: "state",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "pi-collab/state",
    data: { mode, config: { provider: "p", modelId: "m", thinkingLevel: "off" } },
  } as SessionEntry;
}

// Creates the collaborator through CollabMode so its event subscription is attached to the fake.
async function createCollab(mode: "active" | "paused", session = new FakeSession()): Promise<CollabMode> {
  currentSession = session;
  const pi = { getActiveTools: () => [] } as unknown as ExtensionAPI;
  const collab = new CollabMode(pi, new URL("../src/index.ts", import.meta.url).pathname);
  collab.extensionContext = {
    cwd: "/tmp",
    modelRegistry: { find: () => ({}) },
    sessionManager: {
      getBranch: () => [stateEntry(mode)],
      getSessionDir: () => "/nonexistent/pi-collab-test",
      getSessionId: () => "lead",
    },
  } as unknown as ExtensionContext;
  await (collab as unknown as CollabInternals).getOrCreateCollaborator({});
  return collab;
}

describe("interruptCollaborator", () => {
  it("stops the running collaborator and drops its queued messages", async () => {
    const session = new FakeSession();
    const collab = await createCollab("active", session);
    await collab.interruptCollaborator();

    expect(session.clearedQueue).toBe(true);
    expect(session.aborted).toBe(true);
  });

  it("throws when the collaborator is not running", async () => {
    const session = new FakeSession();
    session.isIdle = true;
    session.isStreaming = false;
    const collab = await createCollab("active", session);

    await expect(collab.interruptCollaborator()).rejects.toThrow();
    expect(session.aborted).toBe(false);
  });

  it("throws when collab mode is paused", async () => {
    const session = new FakeSession();
    const collab = await createCollab("paused", session);

    await expect(collab.interruptCollaborator()).rejects.toThrow();
    expect(session.aborted).toBe(false);
  });

  it("ends a pending wait when the collaborator is interrupted", async () => {
    const collab = await createCollab("active");
    const wait = collab.waitForCollaborator(60);
    await collab.interruptCollaborator();

    await expect(wait).resolves.toEqual({ type: "collaboratorInterrupted" });
  });

  it("ends a wait that starts while the interrupt is in progress", async () => {
    const collab = await createCollab("active");
    const interrupt = collab.interruptCollaborator();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wait = collab.waitForCollaborator(60);
    await interrupt;

    await expect(wait).resolves.toEqual({ type: "collaboratorInterrupted" });
  });
});
