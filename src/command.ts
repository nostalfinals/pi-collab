import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CollabConfig, CollabMode } from "./collab-mode.ts";
import { text } from "./text.ts";
import { ModelSelector } from "./tui/model-selector.ts";
import { SelectionPanel } from "./tui/selection-panel.ts";

export async function collabCommand(
  collab: CollabMode,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(text.ui.terminalRequired, "warning");
    return;
  }

  const state = collab.getState(ctx);

  if (state?.mode !== "active") {
    const config = await selectConfig(ctx, state?.config);
    if (config) {
      collab.enable(config);
      ctx.ui.notify(text.ui.configurationSaved, "info");
    }
    return;
  }

  while (true) {
    const action = await ctx.ui.custom<string | undefined>(
      (tui, theme, kb, done) =>
        new SelectionPanel(
          text.ui.overviewTitle(
            `${state.config.provider}/${state.config.modelId}`,
            state.config.thinkingLevel,
          ),
          [
            { value: "disable", label: text.ui.disableOption },
            { value: "change", label: text.ui.changeConfigurationOption },
          ],
          undefined,
          theme,
          kb,
          done,
          () => done(undefined),
          () => tui.requestRender(),
        ),
    );

    if (action === "disable") {
      collab.disable(ctx);
      ctx.ui.notify(text.ui.modeDisabled, "info");
      return;
    }

    if (action !== "change") {
      return;
    }

    const config = await selectConfig(ctx, state.config);

    if (config) {
      collab.updateConfig(ctx, config);
      ctx.ui.notify(text.ui.configurationUpdated, "info");
      return;
    }
  }
}

function getModelSlug(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

async function selectConfig(
  ctx: ExtensionContext,
  current?: CollabConfig,
): Promise<CollabConfig | undefined> {
  await ctx.modelRegistry.refresh();
  const models = ctx.modelRegistry
    .getAvailable()
    .sort((a, b) => getModelSlug(a).localeCompare(getModelSlug(b)));

  if (models.length === 0) {
    ctx.ui.notify(text.ui.noModelsAvailable, "warning");
    return undefined;
  }

  let selected = current
    ? `${current.provider}/${current.modelId}`
    : ctx.model && getModelSlug(ctx.model);

  while (true) {
    const key = await ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
      return new ModelSelector(
        models,
        selected,
        theme,
        kb,
        done,
        () => done(undefined),
        () => tui.requestRender(),
      );
    });

    if (key === undefined) {
      return undefined;
    }

    selected = key;

    const model = models.find((item) => getModelSlug(item) === key)!;
    const level = clampThinkingLevel(
      model,
      current?.thinkingLevel ?? ctx.thinkingLevel ?? "medium",
    );
    const thinkingLevel = await ctx.ui.custom<ModelThinkingLevel | undefined>(
      (tui, theme, kb, done) => {
        return new SelectionPanel(
          text.ui.thinkingLevelSelectorTitle(key),
          getSupportedThinkingLevels(model).map((value) => ({ value, label: value })),
          level,
          theme,
          kb,
          (value) => done(value as ModelThinkingLevel),
          () => done(undefined),
          () => tui.requestRender(),
        );
      },
    );

    if (thinkingLevel !== undefined) {
      return { provider: model.provider, modelId: model.id, thinkingLevel };
    }
  }
}
