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

export class CollabMode {
  private collaboratorSession: Promise<AgentSession> | undefined;
  private collaboratorReport: string | undefined;
  private reportDelivery: Delivery<string> | undefined;
  private leadContext: ExtensionContext | undefined;

  constructor(private pi: ExtensionAPI) {}

  set extensionContext(ctx: ExtensionContext) {
    this.leadContext = ctx;
  }

  getState(ctx: ExtensionContext): CollabState | undefined {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === stateType) {
        return entry.data as CollabState;
      }
    }
    return undefined;
  }

  enable(config: CollabConfig): void {
    this.pi.appendEntry<CollabState>(stateType, { mode: "active", config });
  }

  disable(ctx: ExtensionContext): void {
    const state = this.getState(ctx);
    if (state?.mode === "active") {
      this.pi.appendEntry<CollabState>(stateType, { ...state, mode: "paused" });
    }
  }

  updateConfig(ctx: ExtensionContext, config: CollabConfig): void {
    const state = this.getState(ctx);
    this.pi.appendEntry<CollabState>(stateType, {
      mode: state?.mode ?? "paused",
      config,
    });
  }

  async sendToCollaborator(ctx: ExtensionContext, message: string): Promise<void> {
    const state = this.getState(ctx);
    if (state?.mode !== "active") {
      throw new Error(text.model.collabInactive);
    }

    const session = await this.getOrCreateCollaborator(ctx, state.config);
    if (!session.isStreaming) {
      this.collaboratorReport = undefined;
    }
    void session.prompt(message, { streamingBehavior: "steer" }).catch((error: unknown) => {
      this.deliverReport(error instanceof Error ? error.message : String(error));
    });
  }

  async waitForCollaborator(timeout: number): Promise<string | undefined> {
    if (!this.collaboratorSession) {
      throw new Error(text.model.noCollaborator);
    }
    if (this.reportDelivery) {
      throw new Error(text.model.waitAlreadyPending);
    }

    const delivery = createPendingDelivery<string>();
    this.reportDelivery = delivery;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        delivery.promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeout * 1000);
        }),
      ]);
    } finally {
      if (this.reportDelivery === delivery) {
        this.reportDelivery = undefined;
      }
      clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    const session = this.collaboratorSession;
    this.collaboratorSession = undefined;
    this.collaboratorReport = undefined;
    this.reportDelivery = undefined;
    this.leadContext = undefined;
    if (session) {
      (await session).dispose();
    }
  }

  private getOrCreateCollaborator(
    ctx: ExtensionContext,
    config: CollabConfig,
  ): Promise<AgentSession> {
    if (!this.collaboratorSession) {
      const creation = this.createCollaborator(ctx, config);
      this.collaboratorSession = creation;
      creation.catch(() => {
        if (this.collaboratorSession === creation) {
          this.collaboratorSession = undefined;
        }
      });
    }
    return this.collaboratorSession;
  }

  private async createCollaborator(
    ctx: ExtensionContext,
    config: CollabConfig,
  ): Promise<AgentSession> {
    const model = ctx.modelRegistry.find(config.provider, config.modelId);

    if (!model) {
      throw new Error(`Model not found: ${config.provider}/${config.modelId}`);
    }

    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      noExtensions: true,
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
      tools: ["read", "bash", "edit", "write"],
      resourceLoader,
      sessionManager,
    });

    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
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
      delivery.deliver(report);
      return;
    }

    const ctx = this.leadContext;

    if (!ctx) {
      return;
    }

    const message = {
      customType: reportMessageType,
      content: this.wrapReport(report),
      display: true,
    };

    if (ctx.isIdle()) {
      this.pi.sendMessage(message, { triggerTurn: true });
    } else {
      this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    }
  }

  private wrapReport(message: string): string {
    return `<report_from_collaborator>${message}</report_from_collaborator>`;
  }
}
