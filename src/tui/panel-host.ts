import type { Theme } from "@earendil-works/pi-coding-agent";
import { isFocusable, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

// Hosts a sequence of panels inside a single `ctx.ui.custom` call. Swapping panels
// in place avoids the frame where pi shows the editor between two custom components.
export class PanelHost implements Component, Focusable {
  private panel?: Component;
  private hasFocus = false;

  constructor(
    private tui: TUI,
    readonly theme: Theme,
    readonly keybindings: KeybindingsManager,
  ) {}

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.panel && isFocusable(this.panel)) {
      this.panel.focused = value;
    }
  }

  requestRender = (): void => {
    this.tui.requestRender();
  };

  // Shows the panel created by `create` until it calls `done`. The panel stays
  // visible after that, until the next one replaces it or the host closes.
  show<T>(create: (done: (result: T) => void) => Component): Promise<T> {
    return new Promise((resolve) => {
      if (this.panel && isFocusable(this.panel)) {
        this.panel.focused = false;
      }
      const panel = create(resolve);
      if (isFocusable(panel)) {
        panel.focused = this.hasFocus;
      }
      this.panel = panel;
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    return this.panel?.render(width) ?? [];
  }

  handleInput(data: string): void {
    this.panel?.handleInput?.(data);
  }

  invalidate(): void {
    this.panel?.invalidate();
  }
}
