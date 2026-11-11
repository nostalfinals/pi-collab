import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Spacer,
  Text,
  fuzzyFilter,
  type Focusable,
  type KeybindingsManager,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { text } from "../text.ts";
import { SelectionPanel } from "./selection-panel.ts";

function modelItems(models: Model<Api>[], theme: Theme): SelectItem[] {
  return models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`,
  }));
}

export class ModelSelector extends SelectionPanel implements Focusable {
  private input = new Input({ prompt: "❯ " });

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    private models: Model<Api>[],
    selected: string | undefined,
    theme: Theme,
    keybindings: KeybindingsManager,
    onSelect: (value: string) => void,
    onCancel: () => void,
    requestRender: () => void,
  ) {
    super(
      text.ui.modelSelectorTitle,
      modelItems(models, theme),
      selected,
      theme,
      keybindings,
      onSelect,
      onCancel,
      requestRender,
      text.ui.modelSelectorAdvice,
      true,
    );
    this.decorateList();
  }

  // Wrap the list with the search input above and the selected model's name below.
  private decorateList(): void {
    const selectedName = new Text("", 2, 0);
    const updatePosition = this.list.onSelectionChange;
    const updateName = () => {
      const value = this.list.getSelectedItem()?.value;
      const model = this.models.find((model) => `${model.provider}/${model.id}` === value);
      selectedName.setText(model ? this.theme.fg("muted", text.ui.modelSelectorSelected(model.name)) : "");
    };
    this.list.onSelectionChange = (item) => {
      updatePosition?.(item);
      updateName();
    };
    updateName();
    this.listContainer.children.unshift(this.input, new Spacer(1));
    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(selectedName);
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      super.handleInput(data);
      return;
    }
    this.input.handleInput(data);
    const query = this.input.getValue();
    const filtered = query
      ? fuzzyFilter(this.models, query, (model) => `${model.id} ${model.provider} ${model.name}`)
      : this.models;
    const selected = this.list.getSelectedItem()?.value;
    this.setItems(modelItems(filtered, this.theme), selected);
    this.decorateList();
    this.requestRender();
  }
}
