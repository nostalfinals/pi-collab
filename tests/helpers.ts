import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CollabMode } from "../src/collab-mode.ts";
import { defaultCollaboratorConfig } from "../src/config.ts";

// Keep collaborator creation from reading the developer's real agent config in tests.
process.env.PI_CODING_AGENT_DIR = "/nonexistent/pi-collab-test";

export function stateEntry(mode: "active" | "paused"): SessionEntry {
  return {
    type: "custom",
    id: "state",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "pi-collab/state",
    data: { mode, config: { provider: "p", modelId: "m", thinkingLevel: "off" } },
  } as SessionEntry;
}

export const anchorEntry = {
  type: "custom",
  id: "anchor",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  customType: "pi-collab/anchor",
  data: { collaboratorEntryId: "entry" },
} as SessionEntry;

// Mirrors the parts of AgentSession that CollabMode touches. Starts out running.
export class FakeSession {
  isIdle = false;
  isStreaming = true;
  messages: unknown[] = [];
  clearedQueue = false;
  aborted = false;
  private listener: (event: AgentSessionEvent) => void = () => {};

  async bindExtensions(): Promise<void> {}

  getAllTools(): Array<{ name: string }> {
    return [];
  }

  getActiveToolNames(): string[] {
    return [];
  }

  setActiveToolsByName(_names: string[]): void {}

  subscribe(listener: (event: AgentSessionEvent) => void): void {
    this.listener = listener;
  }

  clearQueue(): void {
    this.clearedQueue = true;
  }

  // Follows pi's order: the session becomes idle first, then agent_settled is emitted with aborted: true.
  async abort(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.aborted = true;
    this.isIdle = true;
    this.isStreaming = false;
    this.listener({ type: "agent_settled", aborted: true } as AgentSessionEvent);
  }

  // Ends the current run with this assistant message, in pi's event order.
  finish(message: unknown): void {
    this.messages.push(message);
    this.isIdle = true;
    this.isStreaming = false;
    this.listener({ type: "message_end", message } as AgentSessionEvent);
    this.listener({ type: "agent_settled", aborted: false } as AgentSessionEvent);
  }
}

let fakeSession: FakeSession | undefined;

// The session that a mocked createAgentSession hands to CollabMode. Test files using
// createCollab mock "@earendil-works/pi-coding-agent" themselves, because vi.mock only
// applies to the file it is written in.
export function currentFakeSession(): FakeSession | undefined {
  return fakeSession;
}

type CollabInternals = {
  getOrCreateCollaborator: (config: unknown) => Promise<FakeSession>;
};

export type CollabCalls = {
  appendEntry: Array<{ type: string; data: unknown }>;
  sendMessage: Array<Record<string, unknown>>;
  notify: Array<{ message: string; type: string | undefined }>;
};

export type CollabOptions = {
  branch?: SessionEntry[];
  // Whether the collaborator session already exists. Otherwise CollabMode has to create it.
  loaded?: boolean;
  leadIdle?: boolean;
  // What modelRegistry.find returns. Defaults to an empty model object.
  model?: unknown;
  // What modelRegistry.hasConfiguredAuth returns.
  auth?: boolean;
  // Filled with the extension API and UI calls made by the collab.
  calls?: CollabCalls;
};

// Creates the collaborator through CollabMode so its event subscription is attached to the fake.
export async function createCollab(session: FakeSession, options: CollabOptions = {}): Promise<CollabMode> {
  const {
    branch = [stateEntry("active")],
    loaded = true,
    leadIdle = true,
    auth = true,
    calls = { appendEntry: [], sendMessage: [], notify: [] },
  } = options;
  const model = "model" in options ? options.model : {};
  fakeSession = session;
  const pi = {
    getActiveTools: () => [],
    sendMessage: (message: Record<string, unknown>) => {
      calls.sendMessage.push(message);
    },
    appendEntry: (type: string, data: unknown) => {
      calls.appendEntry.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  const collab = new CollabMode(pi, new URL("../src/index.ts", import.meta.url).pathname, defaultCollaboratorConfig());
  collab.extensionContext = {
    cwd: "/tmp",
    isIdle: () => leadIdle,
    isProjectTrusted: () => false,
    ui: {
      notify: (message: string, type: string | undefined) => {
        calls.notify.push({ message, type });
      },
    },
    modelRegistry: { find: () => model, hasConfiguredAuth: () => auth },
    sessionManager: {
      getBranch: () => branch,
      getSessionDir: () => "/nonexistent/pi-collab-test",
      getSessionId: () => "lead",
    },
  } as unknown as ExtensionContext;
  if (loaded) {
    await (collab as unknown as CollabInternals).getOrCreateCollaborator({});
  }
  return collab;
}
