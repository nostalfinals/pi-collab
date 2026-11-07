import type { StopReason } from "@earendil-works/pi-ai";
import type { CollaboratorOutcome } from "./collab-mode.ts";

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
  },
  prompt: {
    leadSection:
      "Tools whose names start with `collab_` belong to collab mode. Only use them after the user has turned on collab mode. You will receive a notification when collab mode is turned on.",
    collaboratorSection: "TODO - To be filled",
    collabEnabled: "Collab mode is now enabled. Read the `collab` skill for the collaboration guidelines.",
    collabDisabled:
      "Collab mode is now disabled. You can still perform read-only operations, such as inspecting the collaborator's output, but you cannot send it messages until the user enables collab mode again.",
  },
  model: {
    sendDescription: "Send a message or steer the collaborator.",
    waitDescription: "Wait for the collaborator to finish. The tool result contains its final message.",
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
    collaboratorOutcome: (outcome: CollaboratorOutcome, fullOutputPath?: string) => {
      const body = outcome.error ?? outcome.report;
      const truncated = fullOutputPath ? `\n\n[Report truncated. Full report: ${fullOutputPath}]` : "";
      return body
        ? `<collaborator_report state="${outcome.state}">\n${body}\n</collaborator_report>${truncated}`
        : `<collaborator_report state="${outcome.state}" />`;
    },
    collabInactive: "Collab mode is not active. Ask the user to enable it with /collab before using collab tools.",
    noCollaborator: "No collaborator session exists. Use collab_send before calling collab_wait.",
    collaboratorNotRunning: "The collaborator is not running; there is nothing to wait for.",
    waitAlreadyPending: "A collab_wait call is already in progress. Only one wait can be active at a time.",
  },
};
