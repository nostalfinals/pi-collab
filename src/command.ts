import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";
import type { CollabConfig } from "./types.ts";
import { ModelSelector } from "./tui/model-selector.ts";
import { PanelHost } from "./tui/panel-host.ts";
import { SelectionPanel } from "./tui/selection-panel.ts";

export async function collabCommand(
  collab: CollabMode,
  ctx: ExtensionCommandContext,
  defaultConfig?: CollabConfig,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(text.ui.terminalRequired, "warning");
    return;
  }

  await withPanels(ctx, (host) => collabFlow(collab, ctx, host, defaultConfig));
}

// Runs the whole command inside one custom component, so moving between panels doesn't flicker.
async function withPanels(ctx: ExtensionCommandContext, flow: (host: PanelHost) => Promise<void>): Promise<void> {
  let result: Promise<void> | undefined;
  await ctx.ui.custom<void>((tui, theme, kb, done) => {
    const host = new PanelHost(tui, theme, kb);
    result = flow(host);
    result.then(done, done);
    return host;
  });
  await result;
}

async function collabFlow(
  collab: CollabMode,
  ctx: ExtensionCommandContext,
  host: PanelHost,
  defaultConfig?: CollabConfig,
): Promise<void> {
  const state = collab.state;

  if (state?.mode !== "active") {
    let config: CollabConfig | undefined;
    if (state) {
      const reuse = await confirmReEnable(host);
      if (reuse === undefined) {
        return;
      }
      config = reuse ? state.config : await selectConfig(ctx, host, state.config, defaultConfig);
    } else {
      config = await selectConfig(ctx, host, undefined, defaultConfig);
    }
    if (config && (await applyOrNotify(ctx, () => collab.enable(config)))) {
      ctx.ui.notify(text.ui.configurationSaved, "info");
    }
    return;
  }

  let action: string | undefined;

  while (true) {
    const config = collab.state!.config;
    const configSlug = `${config.provider}/${config.modelId}`;
    const items: SelectItem[] = [
      { value: "model", label: text.ui.modelOption, description: configSlug },
      { value: "thinkingLevel", label: text.ui.thinkingLevelOption, description: config.thinkingLevel },
    ];
    if (await collab.isCollaboratorRunning()) {
      items.push({ value: "stop", label: text.ui.stopCollaborator });
    }
    items.push({ value: "disable", label: text.ui.disableOption });

    const selected = action;
    action = await host.show<string | undefined>(
      (done) =>
        new SelectionPanel(
          text.ui.collabModeTitle,
          items,
          selected,
          host.theme,
          host.keybindings,
          done,
          () => done(undefined),
          host.requestRender,
        ),
    );

    if (action === "model") {
      const model = await selectModel(ctx, host, configSlug);
      if (model) {
        const thinkingLevel = clampThinkingLevel(model, config.thinkingLevel);
        await applyOrNotify(ctx, () =>
          collab.updateConfig({ provider: model.provider, modelId: model.id, thinkingLevel }),
        );
      }
    } else if (action === "thinkingLevel") {
      const model = ctx.modelRegistry.find(config.provider, config.modelId);
      if (!model) {
        ctx.ui.notify(text.ui.modelNotFound(configSlug), "error");
        continue;
      }
      const thinkingLevel = await selectThinkingLevel(host, model, config.thinkingLevel);
      if (thinkingLevel) {
        await applyOrNotify(ctx, () => collab.updateConfig({ ...config, thinkingLevel }));
      }
    } else if (action === "stop") {
      if (await confirmStop(host)) {
        try {
          await collab.interruptCollaborator();
          ctx.ui.notify(text.ui.collaboratorStopped, "info");
        } catch (error) {
          ctx.ui.notify(text.ui.error(error instanceof Error ? error.message : String(error)), "error");
        }
        return;
      }
    } else if (action === "disable") {
      if (await collab.disable()) {
        ctx.ui.notify(text.ui.modeDisabled, "info");
      } else {
        ctx.ui.notify(text.ui.disableWhileRunning, "warning");
      }
      return;
    } else {
      return;
    }
  }
}

async function applyOrNotify(ctx: ExtensionContext, apply: () => Promise<void>): Promise<boolean> {
  try {
    await apply();
    return true;
  } catch (error) {
    ctx.ui.notify(text.ui.configurationFailed(error instanceof Error ? error.message : String(error)), "error");
    return false;
  }
}

function getModelSlug(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

async function confirmReEnable(host: PanelHost): Promise<boolean | undefined> {
  const answer = await host.show<string | undefined>(
    (done) =>
      new SelectionPanel(
        text.ui.reEnableTitle,
        [
          { value: "yes", label: text.ui.yesOption },
          { value: "no", label: text.ui.noOption },
        ],
        "yes",
        host.theme,
        host.keybindings,
        done,
        () => done(undefined),
        host.requestRender,
        text.ui.reEnableConfirm,
      ),
  );
  return answer === undefined ? undefined : answer === "yes";
}

async function confirmStop(host: PanelHost): Promise<boolean> {
  const answer = await host.show<string | undefined>(
    (done) =>
      new SelectionPanel(
        text.ui.stopCollaborator,
        [
          { value: "yes", label: text.ui.yesOption },
          { value: "back", label: text.ui.backOption },
        ],
        "back",
        host.theme,
        host.keybindings,
        done,
        () => done(undefined),
        host.requestRender,
        text.ui.stopCollaboratorConfirm,
      ),
  );
  return answer === "yes";
}

async function selectModel(
  ctx: ExtensionContext,
  host: PanelHost,
  selected: string | undefined,
): Promise<Model<Api> | undefined> {
  const models = ctx.modelRegistry.getAvailable().sort((a, b) => getModelSlug(a).localeCompare(getModelSlug(b)));

  if (models.length === 0) {
    ctx.ui.notify(text.ui.noModelsAvailable, "warning");
    return undefined;
  }

  const key = await host.show<string | undefined>(
    (done) =>
      new ModelSelector(
        models,
        selected,
        host.theme,
        host.keybindings,
        done,
        () => done(undefined),
        host.requestRender,
      ),
  );
  return models.find((model) => getModelSlug(model) === key);
}

async function selectThinkingLevel(
  host: PanelHost,
  model: Model<Api>,
  current?: ModelThinkingLevel,
): Promise<ModelThinkingLevel | undefined> {
  return host.show<ModelThinkingLevel | undefined>(
    (done) =>
      new SelectionPanel(
        text.ui.thinkingLevelSelectorTitle,
        getSupportedThinkingLevels(model).map((value) => ({ value, label: value })),
        current,
        host.theme,
        host.keybindings,
        (value) => done(value as ModelThinkingLevel),
        () => done(undefined),
        host.requestRender,
        text.ui.thinkingLevelSelectorModel(model.name),
      ),
  );
}

// First-time setup: pick a model, then its thinking level. Backing out of the
// thinking level returns to the model list.
async function selectConfig(
  ctx: ExtensionContext,
  host: PanelHost,
  current?: CollabConfig,
  defaultConfig?: CollabConfig,
): Promise<CollabConfig | undefined> {
  const initial = current ?? defaultConfig;
  let selected = initial && `${initial.provider}/${initial.modelId}`;
  const initialThinkingLevel = current?.thinkingLevel ?? defaultConfig?.thinkingLevel;

  while (true) {
    const model = await selectModel(ctx, host, selected);
    if (!model) {
      return undefined;
    }
    selected = getModelSlug(model);

    const thinkingLevel = await selectThinkingLevel(host, model, initialThinkingLevel);
    if (thinkingLevel) {
      return { provider: model.provider, modelId: model.id, thinkingLevel };
    }
  }
}
