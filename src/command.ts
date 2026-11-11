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
import { SelectionPanel } from "./tui/selection-panel.ts";

export async function collabCommand(collab: CollabMode, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(text.ui.terminalRequired, "warning");
    return;
  }

  const state = collab.state;

  if (state?.mode !== "active") {
    const config = await selectConfig(ctx, state?.config);
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
    action = await ctx.ui.custom<string | undefined>(
      (tui, theme, kb, done) =>
        new SelectionPanel(
          text.ui.collabModeTitle,
          items,
          selected,
          theme,
          kb,
          done,
          () => done(undefined),
          () => tui.requestRender(),
        ),
    );

    if (action === "model") {
      const model = await selectModel(ctx, configSlug);
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
      const thinkingLevel = await selectThinkingLevel(ctx, model, config.thinkingLevel);
      if (thinkingLevel) {
        await applyOrNotify(ctx, () => collab.updateConfig({ ...config, thinkingLevel }));
      }
    } else if (action === "stop") {
      if (await confirmStop(ctx)) {
        try {
          await collab.interruptCollaborator();
          ctx.ui.notify(text.ui.collaboratorStopped, "info");
        } catch (error) {
          ctx.ui.notify(text.ui.error(error instanceof Error ? error.message : String(error)), "error");
        }
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

async function confirmStop(ctx: ExtensionContext): Promise<boolean> {
  const answer = await ctx.ui.custom<string | undefined>(
    (tui, theme, kb, done) =>
      new SelectionPanel(
        text.ui.stopCollaborator,
        [
          { value: "yes", label: text.ui.yesOption },
          { value: "back", label: text.ui.backOption },
        ],
        "back",
        theme,
        kb,
        done,
        () => done(undefined),
        () => tui.requestRender(),
        text.ui.stopCollaboratorConfirm,
      ),
  );
  return answer === "yes";
}

async function selectModel(ctx: ExtensionContext, selected: string | undefined): Promise<Model<Api> | undefined> {
  const models = ctx.modelRegistry.getAvailable().sort((a, b) => getModelSlug(a).localeCompare(getModelSlug(b)));

  if (models.length === 0) {
    ctx.ui.notify(text.ui.noModelsAvailable, "warning");
    return undefined;
  }

  const key = await ctx.ui.custom<string | undefined>(
    (tui, theme, kb, done) =>
      new ModelSelector(
        models,
        selected,
        theme,
        kb,
        done,
        () => done(undefined),
        () => tui.requestRender(),
      ),
  );
  return models.find((model) => getModelSlug(model) === key);
}

async function selectThinkingLevel(
  ctx: ExtensionContext,
  model: Model<Api>,
  current: ModelThinkingLevel,
): Promise<ModelThinkingLevel | undefined> {
  return ctx.ui.custom<ModelThinkingLevel | undefined>(
    (tui, theme, kb, done) =>
      new SelectionPanel(
        text.ui.thinkingLevelSelectorTitle,
        getSupportedThinkingLevels(model).map((value) => ({ value, label: value })),
        clampThinkingLevel(model, current),
        theme,
        kb,
        (value) => done(value as ModelThinkingLevel),
        () => done(undefined),
        () => tui.requestRender(),
        text.ui.thinkingLevelSelectorModel(model.name),
      ),
  );
}

// First-time setup: pick a model, then its thinking level. Backing out of the
// thinking level returns to the model list.
async function selectConfig(ctx: ExtensionContext, current?: CollabConfig): Promise<CollabConfig | undefined> {
  let selected = current && `${current.provider}/${current.modelId}`;

  while (true) {
    const model = await selectModel(ctx, selected);
    if (!model) {
      return undefined;
    }
    selected = getModelSlug(model);

    const thinkingLevel = await selectThinkingLevel(
      ctx,
      model,
      current?.thinkingLevel ?? ctx.thinkingLevel ?? "medium",
    );
    if (thinkingLevel) {
      return { provider: model.provider, modelId: model.id, thinkingLevel };
    }
  }
}
