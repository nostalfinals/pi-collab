import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type CollabConfig = {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
};

export type CollabState = {
  mode: "active" | "paused";
  config: CollabConfig;
};

export type CollaboratorAnchor = {
  collaboratorEntryId: string;
};

export type CollaboratorOutcome = {
  type: "completed" | "error";
  body?: string;
  fullOutputPath?: string;
};

// "generating": part of the response still being streamed. "running": a tool call being executed.
export type CollaboratorActivityStatus = "generating" | "running" | undefined;

export type CollaboratorActivity =
  | { type: "text"; text: string; status: CollaboratorActivityStatus }
  | { type: "toolCall"; name: string; arguments: string; truncated: boolean; status: CollaboratorActivityStatus }
  | { type: "error"; message: string };

export type CollaboratorInspection = {
  status: "running" | "idle";
  activities: CollaboratorActivity[];
};

export type CollabWaitResult =
  | { type: "settled"; outcome: CollaboratorOutcome }
  | { type: "reportQueued" }
  | { type: "interruptedByUser" }
  | { type: "aborted" }
  | { type: "collaboratorInterrupted" }
  | { type: "timeout" };
