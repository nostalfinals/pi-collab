import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CollabConfig, CollabMode } from "./collab-mode.ts";
import { SearchSelector } from "./selector.ts";

export async function collabCommand(
  collab: CollabMode,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/collab requires the terminal interface.", "warning");
    return;
  }

  const state = collab.getState(ctx);

  if (state?.mode !== "active") {
    const config = await selectConfig(ctx, state?.config);
    if (config) {
      collab.enable(config);
      ctx.ui.notify(
        "Collaborator configuration saved. Task execution is not implemented yet.",
        "info",
      );
    }
    return;
  }

  while (true) {
    const action = await ctx.ui.custom<string | undefined>(
      (tui, theme, kb, done) =>
        new SearchSelector(
          `Collaborator · ${state.config.provider}/${state.config.modelId} · ${state.config.thinkingLevel}`,
          [
            { value: "disable", label: "Disable" },
            { value: "change", label: "Change model or effort" },
          ],
          undefined,
          theme,
          kb,
          done,
          () => done(undefined),
          () => tui.requestRender(),
          false,
        ),
    );

    if (action === "disable") {
      collab.disable(ctx);
      ctx.ui.notify("Collaborator mode disabled.", "info");
      return;
    }

    if (action !== "change") {
      return;
    }

    const config = await selectConfig(ctx, state.config);

    if (config) {
      collab.updateConfig(ctx, config);
      ctx.ui.notify("Collaborator configuration updated.", "info");
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
    ctx.ui.notify("No models available. Configure a provider with /login first.", "warning");
    return undefined;
  }

  let selected = current
    ? `${current.provider}/${current.modelId}`
    : ctx.model && getModelSlug(ctx.model);

  while (true) {
    const key = await ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
      return new SearchSelector(
        "Collaborator model",
        models.map((model) => ({
          value: getModelSlug(model),
          label: model.id,
          suffix: `[${model.provider}]`,
        })),
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
        return new SearchSelector(
          `Collaborator effort · ${key}`,
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
