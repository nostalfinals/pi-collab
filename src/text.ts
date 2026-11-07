import type { StopReason } from "@earendil-works/pi-ai";
import type { CollaboratorInspection, CollaboratorOutcome } from "./collab-mode.ts";

export const text = {
  ui: {
    collabCommandDescription: "Enable/disable or change the model for collab model",
    terminalRequired: "/collab requires the terminal interface.",
    configurationSaved: "Collaborator configuration saved.",
    modeDisabled: "Collaborator mode disabled.",
    disableWhileRunning: "The collaborator is still running. Wait for it to finish before disabling collab mode.",
    configurationUpdated: "Collaborator configuration updated.",
    collaboratorError: (error: string) => `Collaborator error: ${error}`,
    configurationFailed: (error: string) => `Failed to apply collaborator configuration: ${error}`,
    noModelsAvailable: "No models available. Configure a provider with /login first.",
    modelSelectorTitle: "Which model do you want to use for the collaborator?",
    overviewTitle: (model: string, effort: string) => `Collaborator · ${model} · ${effort}`,
    thinkingLevelSelectorTitle: (model: string) => `Choose the thinking level of ${model}`,
    disableOption: "Disable",
    changeConfigurationOption: "Change model or effort",
    navigationKeyLabel: "↑↓",
    navigationActionLabel: "navigate",
    selectKeyLabel: "enter",
    selectActionLabel: "select",
    backKeyLabel: "esc",
    backActionLabel: "back",
    collabSendToolLabel: "Collab send",
    collabWaitToolLabel: "Collab wait",
    collabInspectToolLabel: "Collab inspect",
  },
  prompt: {
    reminder: (body: string) => `<collab_reminder>\n${body}\n</collab_reminder>`,
    leadSection:
      "Tools whose names start with `collab_` belong to collab mode. Only use them after the user has enabled collab mode. You will receive a notification when collab mode is enabled.",
    collabEnabled: "Collab mode is now enabled. Read the `collab-mode` skill for the collaboration guidelines.",
    collabDisabled:
      "Collab mode is now disabled. You can still perform read-only operations, such as inspecting the collaborator's output, but you cannot send it messages until the user enables collab mode again.",
  },
  model: {
    sendDescription:
      "Send a message to the collaborator. If the collaborator is idle, the message starts a new run. If it is running, the message is added to the current run. Returns immediately; the collaborator works in parallel until the run ends. The collaborator does not see your conversation with the user, but it keeps its own context across runs.",
    waitDescription:
      "Wait up to `timeout` seconds for the collaborator's run to end and return its report. If the wait times out, the collaborator keeps running. If the run already ended, its report arrives as a message instead. A user message interrupts the wait.",
    inspectDescription:
      "Show whether the collaborator is running and its most recent activity: its text messages and tool calls, oldest first. `count` sets how many to return (default 5). Thinking and tool results are not included, and long tool arguments are cut short. Works whether the collaborator is running or idle, and while collab mode is disabled.",
    sendResult: "Message sent.",
    waitTimeoutResult: (timeout: number) => `The collaborator did not finish within ${timeout} seconds.`,
    waitReportQueuedResult:
      "The collaborator finished before the wait started; its report is already queued for delivery.",
    waitInterruptedResult: "Waiting was interrupted by a user message.",
    waitAbortedResult: "Waiting was aborted.",
    collaboratorStartFailed: (error: string) =>
      `The collaborator could not start its run. This is usually a setup problem such as a missing model or missing authentication; ask the user to check the collaborator configuration.\n\nError: ${error}`,
    collaboratorStoppedWithError: (stopReason: StopReason | undefined, error?: string): string => {
      const detail = error ? `\n\nError: ${error}` : "";
      switch (stopReason) {
        case "error":
          return `The collaborator's model request failed, so it stopped before finishing. This is usually a provider or network problem; sending again may work.${detail}`;
        case "length":
          return `The collaborator's response hit the output token limit and was cut off before it finished.${detail}`;
        case "toolUse":
          return `The collaborator's run was ended right after a tool call, before it wrote a final report.${detail}`;
        case undefined:
          return "The collaborator stopped without producing any response.";
        default:
          return `The collaborator stopped unexpectedly (${stopReason}).${detail}`;
      }
    },
    truncatedOutput: (fullOutputPath: string) => `\n\n[Output truncated. Full output: ${fullOutputPath}]`,
    collaboratorActivity: (inspection: CollaboratorInspection): string => {
      const entries = inspection.activities.map((activity) => {
        const truncated = activity.type === "toolCall" && activity.truncated;
        const flags = [activity.status, truncated && "truncated"].filter(Boolean);
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return activity.type === "text"
          ? `[text]${suffix}\n${activity.text}`
          : `[tool_call ${activity.name}]${suffix}\n${activity.arguments}`;
      });
      return [`status: ${inspection.status}`, ...(entries.length > 0 ? entries : ["No activity yet."])].join("\n\n");
    },
    collaboratorOutcome: (outcome: CollaboratorOutcome, fullOutputPath?: string) => {
      const body = outcome.error ?? outcome.report;
      const truncated = fullOutputPath ? `\n\n[Report truncated. Full report: ${fullOutputPath}]` : "";
      return body
        ? `<collaborator_report state="${outcome.state}">\n${body}\n</collaborator_report>${truncated}`
        : `<collaborator_report state="${outcome.state}" />`;
    },
    collabInactive: "Collab mode is not active. Ask the user to enable it with /collab before using collab tools.",
    noCollaborator: "No collaborator session exists yet. Use collab_send to give it an assignment first.",
    collaboratorNotRunning: "The collaborator is not running; there is nothing to wait for.",
    waitAlreadyPending: "A collab_wait call is already in progress. Only one wait can be active at a time.",
  },
};
