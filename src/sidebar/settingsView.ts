// The settings list. Changes are saved at once and apply to every sidebar.

import { LIMITS, type Settings } from "../settings.ts";
import type { KeyEvent } from "../tui/keys.ts";
import { span, type Line, type Row } from "../tui/screen.ts";
import { ListState } from "../tui/widgets.ts";
import { stringWidth } from "../tui/width.ts";
import { VERSION } from "../version.ts";
import { Styles, type Host, type View } from "./view.ts";

interface Item {
  label: string;
  value(settings: Settings): string;
  /** `step` is -1 or +1 from the arrow keys, 0 from Enter. */
  change(settings: Settings, step: number): Partial<Settings>;
}

const onOff = (value: boolean) => (value ? "on" : "off");

function toggle(label: string, key: "autoName" | "nameFromProcess" | "autoOpen" | "followCwd" | "showHidden"): Item {
  return {
    label,
    value: (settings) => onOff(settings[key]),
    change: (settings) => ({ [key]: !settings[key] }),
  };
}

function number(label: string, key: "nameMaxLength" | "width", stepSize: number): Item {
  const { min, max } = LIMITS[key];
  return {
    label,
    value: (settings) => String(settings[key]),
    // Enter steps up and wraps, so the whole range is reachable with one key.
    change: (settings, step) => {
      const next = settings[key] + (step || 1) * stepSize;
      return { [key]: step === 0 && next > max ? min : Math.min(max, Math.max(min, next)) };
    },
  };
}

const ITEMS: Item[] = [
  toggle("Auto tab names", "autoName"),
  number("Tab name length", "nameMaxLength", 2),
  toggle("Name from command", "nameFromProcess"),
  {
    label: "Dock side",
    value: (settings) => settings.dock,
    change: (settings) => ({ dock: settings.dock === "left" ? "right" : "left" }),
  },
  number("Sidebar width", "width", 2),
  toggle("Open in every tab", "autoOpen"),
  toggle("Follow pane folder", "followCwd"),
  toggle("Hidden files", "showHidden"),
];

export class SettingsView implements View {
  private readonly host: Host;
  private readonly list = new ListState();

  constructor(host: Host) {
    this.host = host;
  }

  tab(): string {
    return "⚙";
  }

  header(): Line {
    return [span(" SETTINGS", Styles.bold), span(`  herdr-rail ${VERSION}`, Styles.dim)];
  }

  rows(width: number, height: number): Row[] {
    const settings = this.host.settings();
    this.list.reveal(ITEMS.length, height);
    return ITEMS.slice(this.list.scroll, this.list.scroll + height).map((item, offset) => {
      const value = item.value(settings);
      const gap = Math.max(1, width - stringWidth(item.label) - stringWidth(value) - 3);
      const selected = this.list.scroll + offset === this.list.selected;
      return {
        line: [span(` ${item.label}`), span(" ".repeat(gap)), span(value, Styles.accent)],
        override: selected ? Styles.selected : undefined,
      };
    });
  }

  private change(step: number): void {
    const item = ITEMS[this.list.selected];
    if (item) this.host.updateSettings(item.change(this.host.settings(), step));
  }

  key(event: KeyEvent): boolean {
    if (event.ctrl || event.alt) return false;
    if (this.list.navigate(event, ITEMS.length, ITEMS.length)) return true;
    switch (event.name) {
      case "enter":
      case " ":
        this.change(0);
        return true;
      case "left":
      case "h":
        this.change(-1);
        return true;
      case "right":
      case "l":
        this.change(1);
        return true;
      default:
        return false;
    }
  }

  click(index: number): void {
    const target = this.list.scroll + index;
    if (target >= ITEMS.length) return;
    this.list.selected = target;
    this.change(0);
  }

  scroll(delta: number): void {
    this.list.move(delta, ITEMS.length);
  }

  hints(): string {
    return "enter change";
  }

  keys(): [string, string][] {
    return [
      ["enter", "change"],
      ["←→", "adjust a number"],
      ["", "side and width apply on reopen"],
    ];
  }
}
