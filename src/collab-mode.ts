import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface CollabConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
}

interface CollabState {
  mode: "active" | "paused";
  config: CollabConfig;
}

const stateType = "collab-mode-state";

export class CollabMode {
  constructor(private pi: ExtensionAPI) {}

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
}
