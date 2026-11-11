import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  AgentActivityOutcome,
  AgentSession,
  CustomMessageEntry,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { copyCollaboratorFile, createCollaboratorSession } from "./utils/session.ts";
import { text } from "./text.ts";
import { truncateText } from "./utils/truncation.ts";
import type {
  CollabConfig,
  CollaboratorActivity,
  CollaboratorAnchor,
  CollaboratorInspection,
  CollaboratorOutcome,
  CollabState,
  CollabWaitResult,
} from "./types.ts";

type Delivery<T> = {
  promise: Promise<T>;
  deliver: (value: T) => void;
};

function createWaitingDelivery<T>(): Delivery<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, deliver: resolve };
}

const stateEntryType = "pi-collab/state";
const anchorEntryType = "pi-collab/anchor";

const reportMessageType = "pi-collab/report";
const statusMessageType = "pi-collab/status";
const nudgeMessageType = "pi-collab/nudge";

const collabToolNames = ["collab_send", "collab_wait", "collab_inspect", "collab_interrupt"];
const maxToolArgumentsLength = 500;

export class CollabMode {
  private ctx: ExtensionContext | undefined;
  private cachedState: CollabState | undefined;

  private collaboratorSession: Promise<AgentSession> | undefined;
  private lastAssistant: AssistantMessage | undefined;
  private waitingDelivery: Delivery<CollabWaitResult> | undefined;
  private pendingCollaboratorSteer = false;

  constructor(
    private pi: ExtensionAPI,
    private extensionPath: string,
  ) {}

  set extensionContext(ctx: ExtensionContext) {
    this.ctx = ctx;
    this.cachedState = undefined;
  }

  private get context(): ExtensionContext {
    if (!this.ctx) {
      throw new Error("Lead context is not available.");
    }
    return this.ctx;
  }

  get hasPendingWait(): boolean {
    return this.waitingDelivery !== undefined;
  }

  async beforeLeadSettle(outcome: AgentActivityOutcome): Promise<CustomMessageEntryDraft | undefined> {
    const session = await this.collaboratorSession?.catch(() => undefined);

    if (!session || session.isIdle) {
      return undefined;
    }

    if (outcome === "error") {
      this.ctx?.ui.notify(text.ui.leadStoppedWhileCollaboratorRuns, "warning");
      return undefined;
    }

    if (outcome !== "completed") {
      return undefined;
    }

    return {
      type: "custom_message",
      customType: nudgeMessageType,
      content: text.prompt.reminder(text.prompt.collaboratorStillRunning),
      display: false,
    };
  }

  get state(): CollabState | undefined {
    if (this.cachedState) {
      return this.cachedState;
    }

    const branch = this.context.sessionManager.getBranch();

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === stateEntryType) {
        this.cachedState = entry.data as CollabState;
        return this.cachedState;
      }
    }

    return undefined;
  }

  async enable(config: CollabConfig): Promise<void> {
    await this.applyConfig(config);
    const state: CollabState = { mode: "active", config };
    this.pi.appendEntry<CollabState>(stateEntryType, state);
    this.cachedState = state;
    this.sendStatusMessage();
  }

  // Pausing requires an idle collaborator. Returns false without changing anything while it runs.
  async disable(): Promise<boolean> {
    const session = await this.collaboratorSession?.catch(() => undefined);
    if (session && !session.isIdle) {
      return false;
    }

    const current = this.state;
    if (current?.mode === "active") {
      const state: CollabState = { ...current, mode: "paused" };
      this.pi.appendEntry<CollabState>(stateEntryType, state);
      this.cachedState = state;
      this.sendStatusMessage();
    }
    return true;
  }

  // The last status message, if the latest compaction summarized it away. Only entries
  // before that compaction are read, so the result stays the same between requests.
  get statusMessageLostInCompaction(): CustomMessageEntry | undefined {
    const branch = this.context.sessionManager.getBranch();
    let compactionIndex = branch.length - 1;

    while (compactionIndex >= 0 && branch[compactionIndex].type !== "compaction") {
      compactionIndex--;
    }

    const compaction = branch[compactionIndex];

    if (compaction?.type !== "compaction") {
      return undefined;
    }

    // Pi appends the compaction entry after the kept window, which starts at firstKeptEntryId.
    const keptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    const keptStart = keptIndex === -1 ? compactionIndex : keptIndex;

    for (let i = compactionIndex - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom_message" && entry.customType === statusMessageType) {
        return i < keptStart ? entry : undefined;
      }
    }

    return undefined;
  }

  // Tells Lead the current mode. It does not start a turn; Lead sees it with the next request.
  private sendStatusMessage(): void {
    const mode = this.state?.mode;
    if (!mode) {
      return;
    }
    this.pi.sendMessage({
      customType: statusMessageType,
      content: text.prompt.reminder(mode === "active" ? text.prompt.collabEnabled : text.prompt.collabDisabled),
      display: false,
    });
  }

  async updateConfig(config: CollabConfig): Promise<void> {
    await this.applyConfig(config);
    const state: CollabState = {
      mode: this.state?.mode ?? "paused",
      config,
    };
    this.pi.appendEntry<CollabState>(stateEntryType, state);
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
    const { sessionManager } = this.context;
    await copyCollaboratorFile(previousSessionFile, sessionManager.getSessionDir(), sessionManager.getSessionId());
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

    let session: AgentSession;

    try {
      session = await this.getOrCreateCollaborator(state.config);
    } catch (error) {
      this.notifyCollaboratorError(error instanceof Error ? error.message : String(error));
      throw error;
    }

    if (!session.isStreaming) {
      this.lastAssistant = undefined;
    }

    void session.prompt(message, { streamingBehavior: "steer" }).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.notifyCollaboratorError(errorMessage);
      this.deliverOutcome({ type: "error", body: text.model.collaboratorStartFailed(errorMessage) });
    });
  }

  async waitForCollaborator(timeout: number): Promise<CollabWaitResult> {
    if (this.state?.mode !== "active") {
      throw new Error(text.model.collabInactive);
    }

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

    if (this.waitingDelivery) {
      throw new Error(text.model.waitAlreadyPending);
    }

    const delivery = createWaitingDelivery<CollabWaitResult>();
    this.waitingDelivery = delivery;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        delivery.promise,
        new Promise<CollabWaitResult>((resolve) => {
          timer = setTimeout(() => resolve({ type: "timeout" }), timeout * 1000);
        }),
      ]);
    } finally {
      if (this.waitingDelivery === delivery) {
        this.waitingDelivery = undefined;
      }
      clearTimeout(timer);
    }
  }

  async inspectCollaborator(count: number): Promise<CollaboratorInspection> {
    const state = this.state;
    const hasAnchor = this.context.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === anchorEntryType);

    if (!state) {
      throw new Error(text.model.collabInactive);
    }

    if (!this.collaboratorSession && !hasAnchor) {
      throw new Error(text.model.noCollaborator);
    }

    const session = await this.getOrCreateCollaborator(state.config);
    const { messages, streamingMessage, pendingToolCalls } = session.state;
    const activities: CollaboratorActivity[] = [];

    for (const message of streamingMessage ? [...messages, streamingMessage] : messages) {
      if (message.role !== "assistant") {
        continue;
      }
      const generating = message === streamingMessage;
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          activities.push({ type: "text", text: block.text, status: generating ? "generating" : undefined });
        } else if (block.type === "toolCall") {
          const json = JSON.stringify(block.arguments);
          activities.push({
            type: "toolCall",
            name: block.name,
            arguments: json.slice(0, maxToolArgumentsLength),
            truncated: json.length > maxToolArgumentsLength,
            status: generating ? "generating" : pendingToolCalls.has(block.id) ? "running" : undefined,
          });
        }
      }
      // Pi records a failed or aborted response's error on the message itself.
      if (message.errorMessage) {
        activities.push({ type: "error", message: message.errorMessage });
      }
    }

    return { status: session.isIdle ? "idle" : "running", activities: activities.slice(-count) };
  }

  // Input fires before steering is queued. Wait for the queue so the interrupted
  // tool result and the user's message reach the next model request together.
  async interruptWaitAfterInput(): Promise<void> {
    const delivery = this.waitingDelivery;

    if (!delivery) {
      return;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, attempt === 0 ? 0 : 10);
      });

      if (this.waitingDelivery !== delivery) {
        return;
      }

      if (this.context.hasPendingMessages()) {
        this.waitingDelivery = undefined;
        delivery.deliver({ type: "interruptedByUser" });
        return;
      }
    }
  }

  async interruptCollaborator(): Promise<void> {
    if (this.state?.mode !== "active") {
      throw new Error(text.model.collabInactive);
    }

    const session = await this.collaboratorSession;

    if (!session || session.isIdle) {
      throw new Error(text.model.collaboratorNotRunning);
    }

    session.clearQueue();
    await session.abort();
  }

  async abortCollaborator(): Promise<void> {
    this.lastAssistant = undefined;
    const delivery = this.waitingDelivery;
    if (delivery) {
      this.waitingDelivery = undefined;
      delivery.deliver({ type: "aborted" });
    }

    const session = await this.collaboratorSession;
    await session?.abort();
  }

  async dispose(): Promise<void> {
    const session = this.collaboratorSession;
    const delivery = this.waitingDelivery;

    this.collaboratorSession = undefined;
    this.lastAssistant = undefined;
    this.waitingDelivery = undefined;
    this.pendingCollaboratorSteer = false;
    this.ctx = undefined;
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
    const anchor = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === anchorEntryType);
    const anchorData = anchor?.type === "custom" ? (anchor.data as CollaboratorAnchor | undefined) : undefined;

    const session = await createCollaboratorSession({
      ctx,
      extensionPath: this.extensionPath,
      model: this.findModel(config),
      thinkingLevel: config.thinkingLevel,
      tools: this.pi.getActiveTools().filter((name) => !collabToolNames.includes(name)),
      anchorEntryId: anchorData?.collaboratorEntryId,
    });

    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        // AgentSession persists the message after notifying subscribers.
        queueMicrotask(() => {
          const collaboratorEntryId = session.sessionManager.getLeafId();
          if (collaboratorEntryId && this.ctx) {
            this.pi.appendEntry<CollaboratorAnchor>(anchorEntryType, { collaboratorEntryId });
          }
        });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        this.lastAssistant = event.message;
      } else if (event.type === "agent_settled") {
        const last = this.lastAssistant;
        this.lastAssistant = undefined;
        if (event.aborted) {
          // Aborted runs have no report. Only a wait that started while the abort was
          // in progress is still pending here; Lead-side aborts end their wait earlier.
          const delivery = this.waitingDelivery;
          if (delivery) {
            this.waitingDelivery = undefined;
            delivery.deliver({ type: "collaboratorInterrupted" });
          }
          return;
        }
        if (last?.stopReason !== "stop") {
          if (last?.errorMessage) {
            this.notifyCollaboratorError(last.errorMessage);
          }
          this.deliverOutcome({
            type: "error",
            body: text.model.collaboratorStoppedWithError(last?.stopReason, last?.errorMessage),
          });
          return;
        }
        const report = last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        this.deliverOutcome({ type: "completed", body: report || undefined });
      }
    });

    return session;
  }

  private notifyCollaboratorError(error: string) {
    this.ctx?.ui.notify(text.ui.collaboratorError(error), "error");
  }

  private notifyError(error: string) {
    this.ctx?.ui.notify(text.ui.error(error), "error");
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

  private async deliverOutcome(outcome: CollaboratorOutcome) {
    const delivery = this.waitingDelivery;
    let truncatedBody;
    let outcomeAfterTruncation = outcome;

    try {
      truncatedBody = outcome.body !== undefined ? await truncateText(outcome.body, "head") : undefined;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.notifyError(errorMessage);
    }

    if (truncatedBody !== undefined) {
      outcomeAfterTruncation = {
        ...outcome,
        body: truncatedBody.result.content,
        fullOutputPath: truncatedBody.fullOutputPath,
      };
    }

    if (delivery) {
      this.waitingDelivery = undefined;
      delivery.deliver({ type: "settled", outcome: outcomeAfterTruncation });
      return;
    }

    const ctx = this.ctx;

    if (!ctx) {
      return;
    }

    const message = {
      customType: reportMessageType,
      content: text.model.collaboratorOutcome(outcomeAfterTruncation),
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
