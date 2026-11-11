import { describe, expect, it, vi } from "vitest";
import { createCollab, currentFakeSession, FakeSession, stateEntry } from "./helpers.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAgentSession: async () => ({ session: currentFakeSession() }),
  DefaultResourceLoader: class {
    async reload(): Promise<void> {}
  },
  SessionManager: { create: () => ({ resetLeaf() {} }) },
}));

describe("interruptCollaborator", () => {
  it("stops the running collaborator and drops its queued messages", async () => {
    const session = new FakeSession();
    const collab = await createCollab(session);
    await collab.interruptCollaborator();

    expect(session.clearedQueue).toBe(true);
    expect(session.aborted).toBe(true);
  });

  it("throws when the collaborator is not running", async () => {
    const session = new FakeSession();
    session.isIdle = true;
    session.isStreaming = false;
    const collab = await createCollab(session);

    await expect(collab.interruptCollaborator()).rejects.toThrow();
    expect(session.aborted).toBe(false);
  });

  it("throws when collab mode is paused", async () => {
    const session = new FakeSession();
    const collab = await createCollab(session, { branch: [stateEntry("paused")] });

    await expect(collab.interruptCollaborator()).rejects.toThrow();
    expect(session.aborted).toBe(false);
  });

  it("ends a pending wait when the collaborator is interrupted", async () => {
    const collab = await createCollab(new FakeSession());
    const wait = collab.readCollaborator(60);
    await collab.interruptCollaborator();

    await expect(wait).resolves.toEqual({ type: "collaboratorInterrupted" });
  });

  it("ends a wait that starts while the interrupt is in progress", async () => {
    const collab = await createCollab(new FakeSession());
    const interrupt = collab.interruptCollaborator();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wait = collab.readCollaborator(60);
    await interrupt;

    await expect(wait).resolves.toEqual({ type: "collaboratorInterrupted" });
  });
});
