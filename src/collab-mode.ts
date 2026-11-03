import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { text } from "./text.ts";

export interface CollabConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
}

interface CollabState {
  mode: "active" | "paused";
  config: CollabConfig;
}

export type CollabWaitResult =
  { type: "report"; report: string } | { type: "interrupted" } | { type: "aborted" } | { type: "timeout" };

interface Delivery<T> {
  promise: Promise<T>;
  deliver: (value: T) => void;
}

function createPendingDelivery<T>(): Delivery<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, deliver: resolve };
}

const stateType = "collab-mode-state";
const reportMessageType = "collab-report";
const collabToolNames = ["collab_send", "collab_wait"];

export class CollabMode {
  private collaboratorSession: Promise<AgentSession> | undefined;
  private collaboratorReport: string | undefined;
  private reportDelivery: Delivery<CollabWaitResult> | undefined;
  private leadContext: ExtensionContext | undefined;
  private cachedState: CollabState | undefined;

  constructor(
    private pi: ExtensionAPI,
    private extensionPath: string,
  ) {}

  set extensionContext(ctx: ExtensionContext) {
    this.leadContext = ctx;
    this.cachedState = undefined;
  }

  private get context(): ExtensionContext {
    if (!this.leadContext) {
      throw new Error("Lead context is not available.");
    }
    return this.leadContext;
  }

  get state(): CollabState | undefined {
    if (this.cachedState) {
      return this.cachedState;
    }

    const branch = this.context.sessionManager.getBranch();

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === stateType) {
        this.cachedState = entry.data as CollabState;
        return this.cachedState;
      }
    }

    return undefined;
  }

  enable(config: CollabConfig): void {
    const state: CollabState = { mode: "active", config };
    this.pi.appendEntry<CollabState>(stateType, state);
    this.cachedState = state;
  }

  disable(): void {
    const current = this.state;
    if (current?.mode === "active") {
      const state: CollabState = { ...current, mode: "paused" };
      this.pi.appendEntry<CollabState>(stateType, state);
      this.cachedState = state;
    }
  }

  updateConfig(config: CollabConfig): void {
    const state: CollabState = {
      mode: this.state?.mode ?? "paused",
      config,
    };
    this.pi.appendEntry<CollabState>(stateType, state);
    this.cachedState = state;
  }

  async sendToCollaborator(message: string): Promise<void> {
    const state = this.state;

    if (state?.mode !== "active") {
      throw new Error(text.model.collabInactive);
    }

    const session = await this.getOrCreateCollaborator(state.config);

    if (!session.isStreaming) {
      this.collaboratorReport = undefined;
    }

    void session.prompt(message, { streamingBehavior: "steer" }).catch((error: unknown) => {
      this.deliverReport(error instanceof Error ? error.message : String(error));
    });
  }

  async waitForCollaborator(timeout: number): Promise<CollabWaitResult> {
    if (!this.collaboratorSession) {
      throw new Error(text.model.noCollaborator);
    }

    const session = await this.collaboratorSession;

    if (session.isIdle) {
      throw new Error(text.model.collaboratorNotRunning);
    }

    if (this.reportDelivery) {
      throw new Error(text.model.waitAlreadyPending);
    }

    const delivery = createPendingDelivery<CollabWaitResult>();
    this.reportDelivery = delivery;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        delivery.promise,
        new Promise<CollabWaitResult>((resolve) => {
          timer = setTimeout(() => resolve({ type: "timeout" }), timeout * 1000);
        }),
      ]);
    } finally {
      if (this.reportDelivery === delivery) {
        this.reportDelivery = undefined;
      }
      clearTimeout(timer);
    }
  }

  // Input fires before steering is queued. Wait for the queue so the interrupted
  // tool result and the user's message reach the next model request together.
  async interruptWaitAfterInput(): Promise<void> {
    const delivery = this.reportDelivery;

    if (!delivery) {
      return;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, attempt === 0 ? 0 : 10);
      });

      if (this.reportDelivery !== delivery) {
        return;
      }

      if (this.context.hasPendingMessages()) {
        this.reportDelivery = undefined;
        delivery.deliver({ type: "interrupted" });
        return;
      }
    }
  }

  async abortCollaborator(): Promise<void> {
    this.collaboratorReport = undefined;
    const delivery = this.reportDelivery;
    if (delivery) {
      this.reportDelivery = undefined;
      delivery.deliver({ type: "aborted" });
    }

    const session = await this.collaboratorSession;
    await session?.abort();
  }

  async dispose(): Promise<void> {
    const session = this.collaboratorSession;
    this.collaboratorSession = undefined;
    this.collaboratorReport = undefined;
    this.reportDelivery = undefined;
    this.leadContext = undefined;
    this.cachedState = undefined;
    if (session) {
      (await session).dispose();
    }
  }

  private getOrCreateCollaborator(config: CollabConfig): Promise<AgentSession> {
    if (!this.collaboratorSession) {
      const creation = this.createCollaborator(config);
      this.collaboratorSession = creation;
      creation.catch(() => {
        if (this.collaboratorSession === creation) {
          this.collaboratorSession = undefined;
        }
      });
    }
    return this.collaboratorSession;
  }

  private async createCollaborator(config: CollabConfig): Promise<AgentSession> {
    const ctx = this.context;
    const model = ctx.modelRegistry.find(config.provider, config.modelId);

    if (!model) {
      throw new Error(`Model not found: ${config.provider}/${config.modelId}`);
    }

    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((extension) => extension.resolvedPath !== this.extensionPath),
      }),
      appendSystemPromptOverride: (base) =>
        text.model.collaboratorSystemPrompt ? [...base, text.model.collaboratorSystemPrompt] : base,
    });

    await resourceLoader.reload();

    const sessionDir = join(ctx.sessionManager.getSessionDir(), "collab");
    const sessionManager = SessionManager.create(ctx.cwd, sessionDir, {
      id: ctx.sessionManager.getSessionId(),
    });
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      model,
      thinkingLevel: config.thinkingLevel,
      tools: this.pi.getActiveTools().filter((name) => !collabToolNames.includes(name)),
      resourceLoader,
      sessionManager,
    });

    session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason !== "aborted"
      ) {
        const report = event.message.content
          .filter((part) => part.type === "text")
          .at(-1)
          ?.text.trim();
        if (report) {
          this.collaboratorReport = report;
        }
      } else if (event.type === "agent_settled") {
        const report = this.collaboratorReport;
        this.collaboratorReport = undefined;
        if (report !== undefined) {
          this.deliverReport(report);
        }
      }
    });

    return session;
  }

  private deliverReport(report: string): void {
    const delivery = this.reportDelivery;

    if (delivery) {
      this.reportDelivery = undefined;
      delivery.deliver({ type: "report", report });
      return;
    }

    const ctx = this.leadContext;

    if (!ctx) {
      return;
    }

    const message = {
      customType: reportMessageType,
      content: text.model.waitResult(report),
      display: true,
    };

    if (ctx.isIdle()) {
      this.pi.sendMessage(message, { triggerTurn: true });
    } else {
      this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    }
  }
}
