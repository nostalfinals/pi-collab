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
import { createDelivery, type Delivery } from "./utils/delivery.ts";
import { text } from "./text.ts";
import type { CollaboratorConfig } from "./config.ts";
import { truncateText } from "./utils/truncation.ts";
import type {
  CollabConfig,
  CollaboratorActivity,
  CollaboratorAnchor,
  CollaboratorInspection,
  CollaboratorOutcome,
  CollabState,
  CollabReadResult,
} from "./types.ts";

function extractReportText(message: AssistantMessage): string | undefined {
  const report = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return report || undefined;
}

const stateEntryType = "pi-collab/state";
const anchorEntryType = "pi-collab/anchor";

const reportMessageType = "pi-collab/report";
const statusMessageType = "pi-collab/status";
const nudgeMessageType = "pi-collab/nudge";

const maxToolArgumentsLength = 500;

export class CollabMode {
  private ctx: ExtensionContext | undefined;
  private cachedState: CollabState | undefined;

  private collaboratorSession: Promise<AgentSession> | undefined;
  private manualCompaction: Delivery<void> | undefined;
  private abortController = new AbortController();

  private waitingRead: Delivery<CollabReadResult> | undefined;
  private lastAssistantMessage: AssistantMessage | undefined;
  private pendingReportSteer = false;

  constructor(
    private pi: ExtensionAPI,
    private extensionPath: string,
    private config: CollaboratorConfig,
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

  private abortAndSwapController() {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  get hasPendingWait(): boolean {
    return this.waitingRead !== undefined;
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
    this.pendingReportSteer = false;

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
    const abortSignal = this.abortController.signal;
    const abortError = new Error(text.model.sendWasAborted);

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

    if (abortSignal.aborted) {
      throw abortError;
    }

    if (!session.isStreaming) {
      this.lastAssistantMessage = undefined;
    }

    if (this.manualCompaction) {
      await new Promise<void>((resolve, reject) => {
        if (abortSignal.aborted) {
          reject(abortError);
          return;
        }
        const onAbort = () => reject(abortError);
        abortSignal.addEventListener("abort", onAbort, { once: true });
        this.manualCompaction?.promise.then(() => {
          abortSignal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }

    await new Promise<void>((resolve, reject) => {
      let started = false;

      session
        .prompt(message, {
          streamingBehavior: "steer",
          preflightResult: (disposition) => {
            if (abortSignal.aborted) {
              if (disposition === "started") {
                session.abort();
              } else if (disposition === "queued") {
                session.clearQueue();
              }
              reject(abortError);
              return;
            }

            started = true;
            resolve();
          },
        })
        .catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (!started) {
            this.notifyCollaboratorError(errorMessage);
            reject(new Error(text.model.collaboratorStartFailed(errorMessage)));
            return;
          }

          // Only reached if Pi throws after treating the prompt as started.
          // Usually caused by a Pi bug or another extension's event handler.
          this.notifyCollaboratorError(errorMessage);
        });
    });
  }

  private get hasAnchor(): boolean {
    return this.context.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === anchorEntryType);
  }

  // Waits for a running collaborator's report. When it is not running, reads the result of its last run,
  // which also works while collab mode is paused.
  async readCollaborator(timeout: number): Promise<CollabReadResult> {
    const state = this.state;

    if (!state) {
      throw new Error(text.model.collabInactive);
    }

    if (!this.collaboratorSession && !this.hasAnchor) {
      throw new Error(text.model.noCollaborator);
    }

    const session = await this.getOrCreateCollaborator(state.config);

    if (this.pendingReportSteer) {
      return { type: "reportQueued" };
    }

    if (session.isIdle) {
      return this.readLastRun(session);
    }

    if (this.waitingRead) {
      throw new Error(text.model.readAlreadyPending);
    }

    const delivery = createDelivery<CollabReadResult>();
    this.waitingRead = delivery;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        delivery.promise,
        new Promise<CollabReadResult>((resolve) => {
          timer = setTimeout(() => resolve({ type: "timeout" }), timeout * 1000);
        }),
      ]);
    } finally {
      if (this.waitingRead === delivery) {
        this.waitingRead = undefined;
      }
      clearTimeout(timer);
    }
  }

  private async readLastRun(session: AgentSession): Promise<CollabReadResult> {
    const last = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant" || message.role === "user" || message.role === "toolResult");

    if (last?.role !== "assistant" || last.stopReason !== "stop") {
      return { type: "incomplete", error: last?.role === "assistant" ? last.errorMessage : undefined };
    }

    return {
      type: "settled",
      outcome: await this.truncateOutcome({ type: "completed", body: extractReportText(last) }),
    };
  }

  async inspectCollaborator(count: number): Promise<CollaboratorInspection> {
    const state = this.state;

    if (!state) {
      throw new Error(text.model.collabInactive);
    }

    if (!this.collaboratorSession && !this.hasAnchor) {
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
    const delivery = this.waitingRead;

    if (!delivery) {
      return;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, attempt === 0 ? 0 : 10);
      });

      if (this.waitingRead !== delivery) {
        return;
      }

      if (this.context.hasPendingMessages()) {
        this.waitingRead = undefined;
        delivery.deliver({ type: "interruptedByUser" });
        return;
      }
    }
  }

  async isCollaboratorRunning(): Promise<boolean> {
    const session = await this.collaboratorSession?.catch(() => undefined);
    return session !== undefined && !session.isIdle;
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
    this.abortAndSwapController();
    this.lastAssistantMessage = undefined;
    const delivery = this.waitingRead;

    if (delivery) {
      this.waitingRead = undefined;
      delivery.deliver({ type: "aborted" });
    }

    const session = await this.collaboratorSession;

    session?.clearQueue();
    await session?.abort();
  }

  async dispose(): Promise<void> {
    const session = this.collaboratorSession;

    this.abortAndSwapController();

    if (this.manualCompaction) {
      this.manualCompaction.deliver();
    }

    if (this.waitingRead) {
      this.waitingRead.deliver({ type: "aborted" });
    }

    this.collaboratorSession = undefined;
    this.manualCompaction = undefined;
    this.lastAssistantMessage = undefined;
    this.waitingRead = undefined;
    this.pendingReportSteer = false;
    this.ctx = undefined;
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
    const anchor = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === anchorEntryType);
    const anchorData = anchor?.type === "custom" ? (anchor.data as CollaboratorAnchor | undefined) : undefined;

    const session = await createCollaboratorSession({
      ctx,
      extensionPath: this.extensionPath,
      model: this.findModel(config),
      thinkingLevel: config.thinkingLevel,
      config: this.config,
      leadTools: this.pi.getActiveTools(),
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
        this.lastAssistantMessage = event.message;
      } else if (event.type === "agent_settled") {
        const last = this.lastAssistantMessage;
        this.lastAssistantMessage = undefined;
        if (event.aborted) {
          // Aborted runs have no report. Only a wait that started while the abort was
          // in progress is still pending here; Lead-side aborts end their wait earlier.
          const delivery = this.waitingRead;
          if (delivery) {
            this.waitingRead = undefined;
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
        this.deliverOutcome({ type: "completed", body: extractReportText(last) });
      } else if (event.type === "compaction_start" && event.reason === "manual") {
        this.manualCompaction = createDelivery();
      } else if (event.type === "compaction_end" && event.reason === "manual") {
        if (!this.manualCompaction) {
          return;
        }
        this.manualCompaction.deliver();
        this.manualCompaction = undefined;
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
      this.pendingReportSteer = false;
    }
  }

  private async truncateOutcome(outcome: CollaboratorOutcome): Promise<CollaboratorOutcome> {
    let truncatedBody;

    try {
      truncatedBody = outcome.body !== undefined ? await truncateText(outcome.body, "head") : undefined;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.notifyError(errorMessage);
    }

    if (truncatedBody === undefined) {
      return outcome;
    }

    return {
      ...outcome,
      body: truncatedBody.result.content,
      fullOutputPath: truncatedBody.fullOutputPath,
    };
  }

  private async deliverOutcome(outcome: CollaboratorOutcome) {
    const outcomeAfterTruncation = await this.truncateOutcome(outcome);
    const delivery = this.waitingRead;

    if (delivery) {
      this.waitingRead = undefined;
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
      this.pendingReportSteer = true;
      this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    }
  }
}
