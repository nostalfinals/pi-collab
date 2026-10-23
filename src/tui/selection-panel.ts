import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Spacer,
  Text,
  type KeybindingsManager,
  type SelectItem,
} from "@earendil-works/pi-tui";

import { text } from "../text.ts";

const maxVisible = 10;

export class SelectionPanel extends Container {
  protected list!: SelectList;
  protected listContainer = new Container();

  constructor(
    title: string,
    items: SelectItem[],
    selected: string | undefined,
    protected theme: Theme,
    protected keybindings: KeybindingsManager,
    private onSelect: (value: string) => void,
    private onCancel: () => void,
    protected requestRender: () => void,
    private showPosition = false,
  ) {
    super();
    this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", title), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.setItems(items, selected);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg("dim", text.ui.navigationKeyLabel) +
          theme.fg("muted", ` ${text.ui.navigationActionLabel} · `) +
          theme.fg("dim", text.ui.selectKeyLabel) +
          theme.fg("muted", ` ${text.ui.selectActionLabel} · `) +
          theme.fg("dim", text.ui.backKeyLabel) +
          theme.fg("muted", ` ${text.ui.backActionLabel}`),
        1,
        0,
      ),
    );
    this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  }

  protected setItems(items: SelectItem[], selected?: string): void {
    const list = new SelectList(items, maxVisible, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("muted", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    const index = items.findIndex((item) => item.value === selected);
    if (index >= 0) list.setSelectedIndex(index);
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = this.onCancel;
    this.listContainer.clear();
    this.listContainer.addChild(list);
    // SelectList already displays the position when its items need scrolling.
    if (this.showPosition && items.length <= maxVisible) {
      const position = new Text("", 0, 0);
      const updatePosition = () => {
        const current = items.findIndex((item) => item.value === list.getSelectedItem()?.value);
        position.setText(this.theme.fg("muted", `  (${current + 1}/${items.length})`));
      };
      list.onSelectionChange = updatePosition;
      updatePosition();
      this.listContainer.addChild(position);
    }
    this.list = list;
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
    this.requestRender();
  }
}
