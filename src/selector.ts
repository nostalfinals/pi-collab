import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  SelectList,
  Spacer,
  Text,
  fuzzyFilter,
  type Focusable,
  type KeybindingsManager,
  type SelectItem,
} from "@earendil-works/pi-tui";

interface SearchItem extends SelectItem {
  suffix?: string;
}

export class SearchSelector extends Container implements Focusable {
  private input = new Input();
  private list: SelectList;
  private listContainer = new Container();

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    title: string,
    private items: SearchItem[],
    selected: string | undefined,
    private theme: Theme,
    private keybindings: KeybindingsManager,
    private onSelect: (value: string) => void,
    private onCancel: () => void,
    private requestRender: () => void,
    private searchable = true,
  ) {
    super();
    this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", title), 1, 0));
    this.addChild(new Spacer(1));
    if (searchable) {
      this.addChild(this.input);
      this.addChild(new Spacer(1));
    }
    this.addChild(this.listContainer);
    this.list = this.buildList(items, selected);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter select · Esc back"), 1, 0));
    this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  }

  private buildList(items: SearchItem[], selected?: string): SelectList {
    const rows = items.map((item) => ({
      ...item,
      label: item.suffix ? `${item.label} ${this.theme.fg("muted", item.suffix)}` : item.label,
    }));
    const list = new SelectList(rows, 10, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    const index = items.findIndex((item) => item.value === selected);
    if (index >= 0) list.setSelectedIndex(index);
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = this.onCancel;
    this.listContainer.clear();
    this.listContainer.addChild(list);
    return list;
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
    } else if (this.searchable) {
      this.input.handleInput(data);
      const query = this.input.getValue();
      const filtered = query
        ? fuzzyFilter(
            this.items,
            query,
            (item) => `${item.label} ${item.suffix ?? ""} ${item.description ?? ""}`,
          )
        : this.items;
      this.list = this.buildList(filtered, this.list.getSelectedItem()?.value);
    }
    this.requestRender();
  }
}
