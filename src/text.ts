export const text = {
  ui: {
    collabCommandDescription: "Enable/disable or change the model for collab model",
    terminalRequired: "/collab requires the terminal interface.",
    configurationSaved: "Collaborator configuration saved.",
    modeDisabled: "Collaborator mode disabled.",
    configurationUpdated: "Collaborator configuration updated.",
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
  model: {
    collaboratorSystemPrompt: "TODO - To be filled",
    sendDescription: "Send a message or steer the collaborator.",
    waitDescription: "Wait for the collaborator to finish. The tool result contains its final message.",
    sendResult: "Message sent.",
    waitTimeoutResult: (timeout: number) => `The collaborator did not finish within ${timeout} seconds.`,
    waitReportQueuedResult:
      "The collaborator finished before the wait started; its report is already queued for delivery.",
    waitInterruptedResult: "Waiting was interrupted by a user message.",
    waitAbortedResult: "Waiting was aborted.",
    waitResult: (report: string, fullOutputPath?: string) =>
      `<report_from_collaborator>${report}</report_from_collaborator>${
        fullOutputPath ? `\n\n[Report truncated. Full report: ${fullOutputPath}]` : ""
      }`,
    collabInactive: "Collab mode is not active. Ask the user to enable it with /collab before sending messages.",
    noCollaborator: "No collaborator session exists. Use collab_send before calling collab_wait.",
    collaboratorNotRunning: "The collaborator is not running; there is nothing to wait for.",
    waitAlreadyPending: "A collab_wait call is already in progress. Only one wait can be active at a time.",
  },
};
