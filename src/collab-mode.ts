import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
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

interface CollaboratorAnchor {
  collaboratorEntryId: string;
}

export interface CollaboratorOutcome {
  state: "completed" | "error";
  report?: string;
  error?: string;
}

export type CollabWaitResult =
  | ({ type: "settled" } & CollaboratorOutcome)
  | { type: "reportQueued" }
  | { type: "interrupted" }
  | { type: "aborted" }
  | { type: "timeout" };

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
const anchorType = "collab-anchor";
const reportMessageType = "collab-report";
const collabToolNames = ["collab_send", "collab_wait"];

async function findCollaboratorFile(sessionDir: string, leadSessionId: string): Promise<string | undefined> {
  const collabDir = join(sessionDir, "collab");
  let names: string[];

  try {
    names = await readdir(collabDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const name = names.find((name) => name === `${leadSessionId}.jsonl` || name.endsWith(`_${leadSessionId}.jsonl`));
  return name ? join(collabDir, name) : undefined;
}

function findCollaboratorLeaf(entries: SessionEntry[], anchorId: string): string | null {
  const anchorIndex = entries.findIndex((entry) => entry.id === anchorId);
  if (anchorIndex === -1) {
    return null;
  }

  const nextUserIndex = entries.findIndex(
    (entry, index) => index > anchorIndex && entry.type === "message" && entry.message.role === "user",
  );
  if (nextUserIndex === -1) {
    return entries.at(-1)?.id ?? null;
  }

  for (let i = nextUserIndex - 1; i > anchorIndex; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message.role === "assistant") {
      return entry.id;
    }
  }
  return entries[nextUserIndex - 1]?.id ?? entries[anchorIndex]?.id ?? null;
}

export class CollabMode {
  private collaboratorSession: Promise<AgentSession> | undefined;
  private lastAssistant: AssistantMessage | undefined;
  private reportDelivery: Delivery<CollabWaitResult> | undefined;
  private pendingCollaboratorSteer = false;
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

  get hasPendingWait(): boolean {
    return this.reportDelivery !== undefined;
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

  async enable(config: CollabConfig): Promise<void> {
    await this.applyConfig(config);
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

  async updateConfig(config: CollabConfig): Promise<void> {
    await this.applyConfig(config);
    const state: CollabState = {
      mode: this.state?.mode ?? "paused",
      config,
    };
    this.pi.appendEntry<CollabState>(stateType, state);
    this.cachedState = state;
  }

  // An existing collaborator picks up the new model on its next request.
  // Throws without changing anything if the model is missing or has no auth.
  private async applyConfig(config: CollabConfig): Promise<void> {
    const session = await this.collaboratorSession?.catch(() => undefined);
    if (session) {
      await session.setModel(this.findModel(config));
      session.setThinkingLevel(config.thinkingLevel);
    }
  }

  async copyCollaboratorForFork(previousSessionFile: string): Promise<void> {
    const previousManager = SessionManager.open(previousSessionFile);
    const previousId = previousManager.getSessionId();
    const source = await findCollaboratorFile(dirname(previousSessionFile), previousId);

    if (!source) {
      return;
    }

    const ctx = this.context;
    const targetDir = join(ctx.sessionManager.getSessionDir(), "collab");
    const sourceSuffix = `${previousId}.jsonl`;
    const targetName = `${basename(source).slice(0, -sourceSuffix.length)}${ctx.sessionManager.getSessionId()}.jsonl`;

    await mkdir(targetDir, { recursive: true });
    await copyFile(source, join(targetDir, targetName));
  }

  // Tear down the old branch's collaborator and invalidate branch-local state.
  // The next creation reopens the file and positions its leaf from the latest Lead anchor.
  async syncBranch(): Promise<void> {
    this.cachedState = undefined;
    this.pendingCollaboratorSteer = false;
    const sessionPromise = this.collaboratorSession;

    await this.abortCollaborator();
    if (!sessionPromise) {
      return;
    }

    const session = await sessionPromise;
    this.collaboratorSession = undefined;
    session.dispose();
  }

  async sendToCollaborator(message: string): Promise<void> {
    const state = this.state;

    if (state?.mode !== "active") {
      throw new Error(text.model.collabInactive);
    }

    const session = await this.getOrCreateCollaborator(state.config);

    if (!session.isStreaming) {
      this.lastAssistant = undefined;
    }

    void session.prompt(message, { streamingBehavior: "steer" }).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.notifyError(errorMessage);
      this.deliverOutcome({ state: "error", error: text.model.collaboratorStartFailed(errorMessage) });
    });
  }

  async waitForCollaborator(timeout: number): Promise<CollabWaitResult> {
    if (!this.collaboratorSession) {
      throw new Error(text.model.noCollaborator);
    }

    const session = await this.collaboratorSession;

    if (this.pendingCollaboratorSteer) {
      return { type: "reportQueued" };
    }

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
    this.lastAssistant = undefined;
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
    const delivery = this.reportDelivery;

    this.collaboratorSession = undefined;
    this.lastAssistant = undefined;
    this.reportDelivery = undefined;
    this.pendingCollaboratorSteer = false;
    this.leadContext = undefined;
    this.cachedState = undefined;

    if (delivery) {
      delivery.deliver({ type: "aborted" });
    }

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
    const model = this.findModel(config);
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

    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessionFile = await findCollaboratorFile(sessionDir, ctx.sessionManager.getSessionId());
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile)
      : SessionManager.create(ctx.cwd, join(sessionDir, "collab"), {
          id: ctx.sessionManager.getSessionId(),
        });
    const anchor = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === anchorType);
    const anchorData = anchor?.type === "custom" ? (anchor.data as CollaboratorAnchor | undefined) : undefined;
    const leafId = anchorData
      ? findCollaboratorLeaf(sessionManager.getEntries(), anchorData.collaboratorEntryId)
      : null;
    if (leafId) {
      sessionManager.branch(leafId);
    } else {
      sessionManager.resetLeaf();
    }

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
      if (event.type === "message_end" && event.message.role === "user") {
        // AgentSession persists the message after notifying subscribers.
        queueMicrotask(() => {
          const collaboratorEntryId = session.sessionManager.getLeafId();
          if (collaboratorEntryId && this.leadContext) {
            this.pi.appendEntry<CollaboratorAnchor>(anchorType, { collaboratorEntryId });
          }
        });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        this.lastAssistant = event.message;
      } else if (event.type === "agent_settled") {
        const last = this.lastAssistant;
        this.lastAssistant = undefined;
        if (event.aborted) {
          return;
        }
        if (last?.stopReason !== "stop") {
          if (last?.errorMessage) {
            this.notifyError(last.errorMessage);
          }
          this.deliverOutcome({
            state: "error",
            error: text.model.collaboratorStoppedWithError(last?.stopReason, last?.errorMessage),
          });
          return;
        }
        const report = last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        this.deliverOutcome({ state: "completed", report: report || undefined });
      }
    });

    return session;
  }

  private notifyError(error: string): void {
    this.leadContext?.ui.notify(text.ui.collaboratorError(error), "error");
  }

  private findModel(config: CollabConfig): Model<Api> {
    const model = this.context.modelRegistry.find(config.provider, config.modelId);
    if (!model) {
      throw new Error(`Model not found: ${config.provider}/${config.modelId}`);
    }
    return model;
  }

  handleLeadMessageStart(customType: string): void {
    if (customType === reportMessageType) {
      this.pendingCollaboratorSteer = false;
    }
  }

  private deliverOutcome(outcome: CollaboratorOutcome): void {
    const delivery = this.reportDelivery;

    if (delivery) {
      this.reportDelivery = undefined;
      delivery.deliver({ type: "settled", ...outcome });
      return;
    }

    const ctx = this.leadContext;

    if (!ctx) {
      return;
    }

    const message = {
      customType: reportMessageType,
      content: text.model.collaboratorOutcome(outcome),
      display: true,
    };

    if (ctx.isIdle()) {
      this.pi.sendMessage(message, { triggerTurn: true });
    } else {
      this.pendingCollaboratorSteer = true;
      this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    }
  }
}
