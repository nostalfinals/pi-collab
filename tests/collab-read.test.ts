import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { text } from "../src/text.ts";
import { anchorEntry, createCollab, currentFakeSession, FakeSession, stateEntry } from "./helpers.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAgentSession: async () => ({ session: currentFakeSession() }),
  DefaultResourceLoader: class {
    async reload(): Promise<void> {}
  },
  SessionManager: { create: () => ({ getEntries: () => [], resetLeaf() {} }) },
}));

const user = { role: "user", content: "task" };
const toolResult = { role: "toolResult" };

function assistant(stopReason: string, report = "", errorMessage?: string): unknown {
  return { role: "assistant", stopReason, errorMessage, content: report ? [{ type: "text", text: report }] : [] };
}

function idleSession(...messages: unknown[]): FakeSession {
  const session = new FakeSession();
  session.isIdle = true;
  session.isStreaming = false;
  session.messages = messages;
  return session;
}

function runningSession(): FakeSession {
  const session = new FakeSession();
  session.messages = [user];
  return session;
}

describe("readCollaborator while the collaborator is not running", () => {
  it("returns the report of the last run when it ended with a finished response", async () => {
    const collab = await createCollab(idleSession(user, assistant("stop", "all done")));

    await expect(collab.readCollaborator(60)).resolves.toEqual({
      type: "settled",
      outcome: { type: "completed", body: "all done" },
    });
  });

  it("reports an unfinished run with the error when the last response failed", async () => {
    const collab = await createCollab(idleSession(user, assistant("error", "", "500: boom")));

    await expect(collab.readCollaborator(60)).resolves.toEqual({ type: "incomplete", error: "500: boom" });
  });

  it("reports an unfinished run when the last response was aborted", async () => {
    const collab = await createCollab(idleSession(user, assistant("aborted", "", "Operation aborted")));

    await expect(collab.readCollaborator(60)).resolves.toEqual({ type: "incomplete", error: "Operation aborted" });
  });

  it("reports an unfinished run when the last message is a tool result or an unanswered user message", async () => {
    const stoppedAfterTool = await createCollab(idleSession(user, assistant("toolUse"), toolResult));
    const unanswered = await createCollab(idleSession(user, assistant("stop", "all done"), user));

    await expect(stoppedAfterTool.readCollaborator(60)).resolves.toEqual({ type: "incomplete" });
    await expect(unanswered.readCollaborator(60)).resolves.toEqual({ type: "incomplete" });
  });

  it("ignores custom messages after the last response", async () => {
    const custom = { role: "custom", customType: "other", content: "note" };
    const collab = await createCollab(idleSession(user, assistant("stop", "all done"), custom));

    await expect(collab.readCollaborator(60)).resolves.toEqual({
      type: "settled",
      outcome: { type: "completed", body: "all done" },
    });
  });

  it("truncates a long report and saves the full report to a file", async () => {
    const report = Array.from({ length: 100 }, () => "a".repeat(1023)).join("\n");
    const collab = await createCollab(idleSession(user, assistant("stop", report)));
    const result = await collab.readCollaborator(60);

    if (result.type !== "settled" || !result.outcome.fullOutputPath) {
      throw new Error("Expected a truncated report");
    }

    try {
      expect(result.outcome.body?.length).toBeLessThan(report.length);
      expect(await readFile(result.outcome.fullOutputPath, "utf8")).toBe(report);
    } finally {
      await rm(dirname(result.outcome.fullOutputPath), { recursive: true, force: true });
    }
  });
});

describe("readCollaborator while the collaborator is running", () => {
  it("waits for the run to end and returns its report", async () => {
    const session = runningSession();
    const collab = await createCollab(session);
    const read = collab.readCollaborator(60);
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.finish(assistant("stop", "all done"));

    await expect(read).resolves.toEqual({ type: "settled", outcome: { type: "completed", body: "all done" } });
  });

  it("times out when the run does not end in time", async () => {
    const collab = await createCollab(runningSession());

    await expect(collab.readCollaborator(0.01)).resolves.toEqual({ type: "timeout" });
  });

  it("rejects a second read while one is already waiting", async () => {
    const session = runningSession();
    const collab = await createCollab(session);
    const read = collab.readCollaborator(60);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(collab.readCollaborator(60)).rejects.toThrow(text.model.readAlreadyPending);

    session.finish(assistant("stop", "all done"));
    await read;
  });
});

describe("readCollaborator preconditions", () => {
  it("says the report is queued when it is already on its way to the lead", async () => {
    const session = runningSession();
    const collab = await createCollab(session, { leadIdle: false });
    // The run ends while the lead is busy and not waiting, so the report is queued as a steer.
    session.finish(assistant("stop", "all done"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(collab.readCollaborator(60)).resolves.toEqual({ type: "reportQueued" });
  });

  it("loads the collaborator when the branch has an anchor but no session is loaded", async () => {
    const collab = await createCollab(idleSession(user, assistant("stop", "restored")), {
      branch: [stateEntry("active"), anchorEntry],
      loaded: false,
    });

    await expect(collab.readCollaborator(60)).resolves.toEqual({
      type: "settled",
      outcome: { type: "completed", body: "restored" },
    });
  });

  it("throws when the branch has neither a collaborator session nor an anchor", async () => {
    const collab = await createCollab(idleSession(), { loaded: false });

    await expect(collab.readCollaborator(60)).rejects.toThrow(text.model.noCollaborator);
  });

  it("throws when collab mode was never enabled", async () => {
    const collab = await createCollab(idleSession(), { branch: [], loaded: false });

    await expect(collab.readCollaborator(60)).rejects.toThrow(text.model.collabInactive);
  });

  it("reads the last run while collab mode is paused", async () => {
    const collab = await createCollab(idleSession(user, assistant("stop", "all done")), {
      branch: [stateEntry("paused")],
    });

    await expect(collab.readCollaborator(60)).resolves.toEqual({
      type: "settled",
      outcome: { type: "completed", body: "all done" },
    });
  });
});
