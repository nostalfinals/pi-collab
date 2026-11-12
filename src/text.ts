import type { StopReason } from "@earendil-works/pi-ai";
import type { CollaboratorInspection, CollaboratorOutcome } from "./types.ts";

export const text = {
  ui: {
    collabCommandDescription: "Let a collaborator agent work alongside the main agent",
    terminalRequired: "/collab requires the terminal interface.",
    configurationSaved: "Collaborator configuration saved.",
    modeDisabled: "Collab mode disabled.",
    disableWhileRunning: "The collaborator is still running. Wait for it to finish before disabling collab mode.",
    error: (error: string) => `Error: ${error}`,
    collaboratorError: (error: string) => `Collaborator error: ${error}`,
    collaboratorExtensionError: (extensionPath: string, error: string, stack: string | undefined) => {
      // The first stack line repeats the error message.
      const stackLines = (stack?.split("\n").slice(1) ?? []).map((line) => `\n  ${line.trim()}`);
      return `Collaborator extension "${extensionPath}" error: ${error}${stackLines.join("")}`;
    },
    configurationFailed: (error: string) => `Failed to apply collaborator configuration: ${error}`,
    leadStoppedWhileCollaboratorRuns:
      "The lead agent stopped unexpectedly while the collaborator is still running. Its report will be sent to the lead when it finishes, or you can stop the collaborator in /collab.",
    modelNotFound: (model: string) => `Model not found: ${model}`,
    noModelsAvailable: "No models available. Configure a provider with /login first.",
    modelSelectorTitle: "Select a model for the collaborator",
    modelSelectorAdvice:
      "A cheaper model that is capable enough and follows instructions well is usually a great choice.\nIf you don't see the model you want, open /model to refresh the model catalog.",
    modelSelectorSelected: (name: string) => `Selected: ${name}`,
    collabModeTitle: `Collab Mode`,
    reEnableTitle: "Re-enable collab mode",
    reEnableConfirm:
      "Collab mode was enabled earlier in this session.\nContinue with the existing model and thinking level configuration?",
    thinkingLevelSelectorTitle: "Select a thinking level for the collaborator",
    thinkingLevelSelectorModel: (name: string) => `Model: ${name}`,
    modelOption: "Model",
    thinkingLevelOption: "Thinking level",
    stopCollaborator: "Stop collaborator",
    stopCollaboratorConfirm:
      "This will stop the running collaborator, and its current task may be left unfinished.\nContinue?",
    collaboratorStopped: "Collaborator stopped.",
    yesOption: "Yes",
    noOption: "No",
    backOption: "Back",
    disableOption: "Disable",
    navigationKeyLabel: "↑↓",
    navigationActionLabel: "navigate",
    selectKeyLabel: "enter",
    selectActionLabel: "select",
    backKeyLabel: "esc",
    backActionLabel: "back",
    collabSendToolLabel: "Collab send",
    collabReadToolLabel: "Collab read",
    collabInspectToolLabel: "Collab inspect",
    collabInterruptToolLabel: "Collab interrupt",
  },
  prompt: {
    reminder: (body: string) => `<collab_reminder>\n${body}\n</collab_reminder>`,
    leadSection:
      "Tools whose names start with `collab_` belong to collab mode. Only use them after the user has enabled collab mode. You will receive a notification when collab mode is enabled.",
    collabEnabled: "Collab mode is now enabled. Read the `collab-mode` skill for the collaboration guidelines.",
    collaboratorStillRunning:
      "The collaborator is still running, so do not end your turn yet. Call `collab_read` to wait for its report, or `collab_interrupt` if it is stuck.",
    collabDisabled:
      "Collab mode is now disabled. You can still perform read-only operations, such as inspecting the collaborator's output, but you cannot send it messages until the user enables collab mode again.",
  },
  model: {
    sendDescription:
      "Send a message to the collaborator. If the collaborator is idle, the message starts a new run. If it is running, the message is added to the current run. Returns once the run has started or the message has been added; the collaborator works in parallel until the run ends. The collaborator does not see your conversation with the user, but it keeps its own context across runs.",
    readDescription:
      "Read the collaborator's report. If the collaborator is running, wait up to `timeout` seconds (default 300, at most 1200) for its run to end and return its report; if the wait times out, the collaborator keeps running. If it is not running, return the report of its last run right away, or say that the run stopped before finishing. A user message interrupts the wait. Works while collab mode is disabled.",
    inspectDescription:
      "Show whether the collaborator is running and its most recent activity: its text messages and tool calls, oldest first. `count` sets how many to return (default 5). Thinking and tool results are not included, and long tool arguments are cut short. Works whether the collaborator is running or idle, and while collab mode is disabled.",
    interruptDescription:
      "Stop the collaborator's current run, for example when it is stuck on a command that does not return. Queued messages to the collaborator are dropped. The collaborator keeps its context, and the interrupted run produces no report. Use collab_send to start a new run.",
    sendResult: "Message sent.",
    interruptResult: "The collaborator was interrupted.",
    readTimeoutResult: (timeout: number) => `The collaborator did not finish within ${timeout} seconds.`,
    readReportQueuedResult:
      "The collaborator finished before the wait started; its report is already queued for delivery.",
    readInterruptedByUserResult: "Waiting was interrupted by a user message.",
    readAbortedResult: "Waiting was aborted.",
    readCollaboratorInterruptedResult: "The collaborator was interrupted by you or the user, so there is no report.",
    readIncompleteResult: (error: string | undefined) =>
      `The collaborator stopped before finishing its task, so there is no report. Use collab_inspect to see how far it got.${error ? `\n\nError: ${error}` : ""}`,
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
        if (activity.type === "error") {
          return `[error]\n${activity.message}`;
        }
        const truncated = activity.type === "toolCall" && activity.truncated;
        const flags = [activity.status, truncated && "truncated"].filter(Boolean);
        const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return activity.type === "text"
          ? `[text]${suffix}\n${activity.text}`
          : `[tool_call ${activity.name}]${suffix}\n${activity.arguments}`;
      });
      return [`status: ${inspection.status}`, ...(entries.length > 0 ? entries : ["No activity yet."])].join("\n\n");
    },
    collaboratorOutcome: (outcome: CollaboratorOutcome) => {
      const truncated = outcome.fullOutputPath ? `\n\n[Report truncated. Full report: ${outcome.fullOutputPath}]` : "";
      return outcome.body
        ? `<collaborator_report state="${outcome.type}">\n${outcome.body}\n</collaborator_report>${truncated}`
        : `<collaborator_report state="${outcome.type}" />`;
    },
    collabInactive: "Collab mode is not active. Ask the user to enable it with /collab before using collab tools.",
    noCollaborator: "No collaborator session exists yet. Use collab_send to give it an assignment first.",
    collaboratorNotRunning: "The collaborator is not running.",
    readAlreadyPending: "A collab_read call is already waiting. Only one wait can be active at a time.",
  },
};
