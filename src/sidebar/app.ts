// The sidebar process: one pane, three views, and the modal layer over them.

import path from "node:path";
import { setHidden, stampSidebar } from "../dock.ts";
import * as git from "../git.ts";
import { call, comparePaneIds, PLUGIN_ID, snapshot as takeSnapshot, type PaneInfo, type Snapshot } from "../herdr.ts";
import { nameTabs } from "../namer.ts";
import { isRailPane, TOKEN_PREVIEW } from "../naming.ts";
import { loadSettings, saveSettings, sessionDir, writeJson, type Settings } from "../settings.ts";
import type { InputEvent, KeyEvent, MouseEvent } from "../tui/keys.ts";
import { Color, Screen, span, type Cursor, type Line, type Row } from "../tui/screen.ts";
import { openTerminal, type Terminal } from "../tui/term.ts";
import { ListState, TextInput } from "../tui/widgets.ts";
import { printable, skipColumns, stringWidth, truncate } from "../tui/width.ts";
import { Explorer, listDir } from "./explorer.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { SourceControl } from "./scm.ts";
import { SettingsView } from "./settingsView.ts";
import { Styles, type Host, type PreviewTarget, type View } from "./view.ts";

const TICK_MS = 2000;
/** Ticks between identity heartbeats; well inside the token's lifetime. */
const HEARTBEAT_TICKS = 4;
const FLASH_MS = 4000;
const DOUBLE_CLICK_MS = 400;
const FIND_LIMIT = 200;
/** Files listed for quick open outside a git repository. */
const WALK_LIMIT = 5000;
const WALK_SKIP = new Set(["node_modules", "target", "dist", "build", ".venv", "__pycache__"]);

type Modal =
  | { kind: "confirm"; question: string; onYes: () => void }
  | {
      kind: "prompt";
      label: string;
      input: TextInput;
      onSubmit: (value: string) => void;
      onCancel?: (value: string) => void;
    }
  | { kind: "find"; input: TextInput; files: string[] | null; matches: string[]; list: ListState }
  | { kind: "help" };

const GLOBAL_KEYS: [string, string][] = [
  ["1 2 3 tab", "switch view"],
  ["r", "refresh"],
  ["b", "hide sidebar here"],
  ["q", "close"],
];

/** Every file under `root`, for folders that are not git repositories. */
function walkFiles(root: string): string[] {
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0 && files.length < WALK_LIMIT) {
    const dir = queue.shift() as string;
    for (const entry of listDir(path.join(root, dir), false)) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (!entry.dir) files.push(relative);
      else if (!WALK_SKIP.has(entry.name)) queue.push(relative);
    }
  }
  return files;
}

class App implements Host {
  private readonly term: Terminal;
  private readonly screen: Screen;
  private readonly paneId = process.env.HERDR_PANE_ID ?? "";
  private current: Settings = loadSettings();
  private root: string;
  private readonly explorer: Explorer;
  private readonly scm: SourceControl;
  private readonly views: View[];
  private active = 0;
  private modal: Modal | null = null;
  private message: { text: string; until: number } | null = null;
  private tabRanges: { from: number; to: number }[] = [];
  private lastClick = { y: -1, at: 0 };
  private me: PaneInfo | undefined;
  private ticks = 0;
  private ticking = false;
  private refreshing = false;
  private refreshAgain = false;
  /** The pane and folder last followed, so a manual folder choice survives until that pane moves. */
  private followed = { pane: "", dir: "" };

  constructor(root: string) {
    this.root = root;
    this.followed.dir = root;
    this.explorer = new Explorer(this, root);
    this.scm = new SourceControl(this);
    this.views = [this.explorer, this.scm, new SettingsView(this)];
    this.term = openTerminal({ input: (event) => this.input(event), resize: () => this.redraw() }, "herdr-rail");
    this.screen = new Screen((data) => this.term.write(data));
  }

  start(): void {
    this.redraw();
    void this.refresh();
    void this.tick();
    setInterval(() => void this.tick(), TICK_MS);
  }

  // ---- Host ----

  settings(): Settings {
    return this.current;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.current = { ...this.current, ...patch };
    saveSettings(this.current);
    this.current = loadSettings();
    this.explorer.reload();
    this.redraw();
  }

  flash(text: string): void {
    this.message = { text, until: Date.now() + FLASH_MS };
    setTimeout(() => this.redraw(), FLASH_MS + 20);
    this.redraw();
  }

  setRoot(dir: string): void {
    this.showRoot(dir);
  }

  preview(target: PreviewTarget): void {
    this.openPreview(target).catch((error: Error) => this.flash(error.message));
  }

  confirm(question: string, onYes: () => void): void {
    this.modal = { kind: "confirm", question, onYes };
    this.redraw();
  }

  prompt(label: string, initial: string, onSubmit: (value: string) => void, onCancel?: (value: string) => void): void {
    this.modal = { kind: "prompt", label, input: new TextInput(initial), onSubmit, onCancel };
    this.redraw();
  }

  copy(text: string): void {
    // OSC 52: the terminal puts it on the clipboard, locally or over SSH.
    this.term.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const status = await git.status(this.root);
      this.explorer.setStatus(status);
      this.scm.setStatus(status);
      this.explorer.reload();
    } finally {
      this.refreshing = false;
    }
    this.redraw();
    if (this.refreshAgain) {
      this.refreshAgain = false;
      await this.refresh();
    }
  }

  // ---- herdr ----

  private showRoot(dir: string): void {
    if (dir === this.root) return;
    this.root = dir;
    this.explorer.setRoot(dir);
    void this.refresh();
  }

  /** Follow the folder of the pane next to the sidebar. */
  private follow(snap: Snapshot, me: PaneInfo): void {
    const siblings = snap.panes
      .filter((pane) => pane.tab_id === me.tab_id && !isRailPane(pane))
      .sort((a, b) => comparePaneIds(a.pane_id, b.pane_id));
    const focused = snap.layouts.find((layout) => layout.tab_id === me.tab_id)?.focused_pane_id;
    const pick =
      siblings.find((pane) => pane.pane_id === focused) ??
      siblings.find((pane) => pane.pane_id === this.followed.pane) ??
      siblings[0];
    const dir = pick?.foreground_cwd ?? pick?.cwd;
    if (!pick || !dir) return;
    const moved = dir !== this.followed.dir;
    this.followed = { pane: pick.pane_id, dir };
    if (moved) this.showRoot(dir);
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.paneId) return;
    this.ticking = true;
    try {
      const snap = await takeSnapshot();
      if (this.ticks % HEARTBEAT_TICKS === 0) await stampSidebar(this.paneId);
      this.ticks += 1;
      this.me = snap.panes.find((pane) => pane.pane_id === this.paneId);
      if (!this.me) return;
      this.current = loadSettings();
      // A sidebar in a background tab stays quiet: nobody is looking at it.
      if (snap.focused_tab_id === this.me.tab_id) {
        if (this.current.followCwd) this.follow(snap, this.me);
        await this.refresh();
      }
      if (this.current.autoName && this.ticks % 2 === 0) {
        await nameTabs({ snapshot: snap, settings: this.current });
      }
    } catch {
      // herdr is restarting or busy; the next tick tries again.
    } finally {
      this.ticking = false;
    }
  }

  private async openPreview(target: PreviewTarget): Promise<void> {
    if (!this.paneId) throw new Error("Previews open in a herdr tab; run the sidebar inside herdr");
    const snap = await takeSnapshot();
    const me = snap.panes.find((pane) => pane.pane_id === this.paneId);
    if (!me) throw new Error("This pane is not part of the herdr session");
    // One preview per workspace: it watches this file and shows what it names.
    const control = path.join(sessionDir(), `preview-${me.workspace_id.replace(/[^\w.-]/g, "_")}.json`);
    writeJson(control, { target, origin: this.paneId, at: Date.now() });
    const existing = snap.panes.find(
      (pane) => pane.workspace_id === me.workspace_id && TOKEN_PREVIEW in (pane.tokens ?? {}),
    );
    // Take the screen only when this sidebar is on it; one driven from a
    // background tab must not pull the user over.
    const onScreen = snap.focused_tab_id === me.tab_id;
    if (existing) {
      if (onScreen) await call("pane.focus", { pane_id: existing.pane_id });
      return;
    }
    await call("plugin.pane.open", {
      plugin_id: PLUGIN_ID,
      entrypoint: "preview",
      placement: "tab",
      workspace_id: me.workspace_id,
      focus: onScreen,
      env: { RAIL_PREVIEW_CTL: control },
    });
  }

  private quit(hide: boolean): void {
    if (hide && this.me) setHidden(this.me.tab_id, true);
    this.term.close();
    process.exit(0);
  }

  // ---- input ----

  private input(event: InputEvent): void {
    if (event.type === "paste") {
      if (this.modal?.kind === "prompt" || this.modal?.kind === "find") {
        this.modal.input.insert(event.text);
        if (this.modal.kind === "find") this.filter();
      }
    } else if (event.type === "mouse") {
      this.mouse(event);
    } else if (this.modal) {
      this.modalKey(event);
    } else {
      this.key(event);
    }
    this.redraw();
  }

  private key(event: KeyEvent): void {
    if (event.ctrl && (event.name === "q" || event.name === "c")) this.quit(false);
    if (event.ctrl && event.name === "p") return this.openFind();
    if (!event.ctrl && !event.alt) {
      switch (event.name) {
        case "q":
          return this.quit(false);
        case "b":
          return this.quit(true);
        case "1":
        case "2":
        case "3":
          this.active = Number(event.name) - 1;
          return;
        case "tab":
          this.active = (this.active + (event.shift ? this.views.length - 1 : 1)) % this.views.length;
          return;
        case "/":
          return this.openFind();
        case "?":
          this.modal = { kind: "help" };
          return;
        case "r":
          void this.refresh();
          this.flash("Refreshed");
          return;
        default:
          break;
      }
    }
    this.views[this.active].key(event);
  }

  private modalKey(event: KeyEvent): void {
    const modal = this.modal;
    if (!modal) return;
    if (modal.kind === "help") {
      this.modal = null;
    } else if (modal.kind === "confirm") {
      this.modal = null;
      if (event.name === "y" || event.name === "Y") modal.onYes();
    } else if (modal.kind === "prompt") {
      if (event.name === "enter") {
        this.modal = null;
        modal.onSubmit(modal.input.value);
      } else if (event.name === "escape" || (event.ctrl && event.name === "c")) {
        this.modal = null;
        modal.onCancel?.(modal.input.value);
      } else {
        modal.input.key(event);
      }
    } else if (event.name === "escape" || (event.ctrl && event.name === "c")) {
      this.modal = null;
    } else if (event.name === "enter") {
      this.openMatch(modal.list.selected);
    } else if (event.name === "up" || (event.ctrl && event.name === "p")) {
      modal.list.move(-1, modal.matches.length);
    } else if (event.name === "down" || (event.ctrl && event.name === "n")) {
      modal.list.move(1, modal.matches.length);
    } else if (modal.input.key(event)) {
      this.filter();
    }
  }

  private mouse(event: MouseEvent): void {
    const find = this.modal?.kind === "find" ? this.modal : null;
    if (event.action === "wheel-up" || event.action === "wheel-down") {
      const delta = event.action === "wheel-up" ? -3 : 3;
      if (find) find.list.move(delta, find.matches.length);
      else if (!this.modal) this.views[this.active].scroll(delta);
      return;
    }
    if (event.action !== "down" || event.button !== 0) return;
    if (this.modal?.kind === "help") {
      this.modal = null;
      return;
    }
    const now = Date.now();
    const double = event.y === this.lastClick.y && now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { y: event.y, at: now };
    if (event.y === 0) {
      const index = this.tabRanges.findIndex((range) => event.x >= range.from && event.x < range.to);
      if (index >= 0 && this.modal?.kind !== "prompt" && this.modal?.kind !== "confirm") {
        this.modal = null;
        this.active = index;
      }
    } else if (event.y >= 2 && event.y < this.term.rows() - 1) {
      if (find) this.openMatch(find.list.scroll + event.y - 2);
      else if (!this.modal) this.views[this.active].click(event.y - 2, double);
    }
  }

  // ---- quick open ----

  private openFind(): void {
    const modal: Modal = { kind: "find", input: new TextInput(), files: null, matches: [], list: new ListState() };
    this.modal = modal;
    const root = this.root;
    void git.listFiles(root).then((files) => {
      modal.files = files ?? walkFiles(root);
      if (this.modal === modal) {
        this.filter();
        this.redraw();
      }
    });
  }

  private filter(): void {
    if (this.modal?.kind !== "find") return;
    this.modal.matches = fuzzyFilter(this.modal.input.value, this.modal.files ?? [], FIND_LIMIT);
    this.modal.list.selected = 0;
    this.modal.list.scroll = 0;
  }

  private openMatch(index: number): void {
    if (this.modal?.kind !== "find") return;
    const match = this.modal.matches[index];
    if (!match) return;
    this.modal = null;
    this.preview({ kind: "file", path: path.join(this.root, match) });
  }

  // ---- drawing ----

  private tabsLine(): Line {
    const line: Line = [span(" ")];
    let x = 1;
    this.tabRanges = this.views.map((view, index) => {
      const text = ` ${view.tab()} `;
      const from = x;
      x += stringWidth(text) + 1;
      line.push(span(text, index === this.active ? { bold: true, inverse: true } : Styles.dim), span(" "));
      return { from, to: x - 1 };
    });
    return line;
  }

  /** A text field after `label`, scrolled so the cursor stays visible. */
  private field(label: string, input: TextInput, width: number, y: number): { line: Line; cursor: Cursor } {
    const room = Math.max(1, width - stringWidth(label) - 1);
    const column = input.cursorColumn();
    const skip = Math.max(0, column - room + 1);
    return {
      line: [span(label, Styles.accent), span(skipColumns(printable(input.value), skip))],
      cursor: { x: stringWidth(label) + column - skip, y },
    };
  }

  private footer(width: number, y: number): { row: Row; cursor: Cursor | null } {
    const modal = this.modal;
    if (modal?.kind === "confirm") {
      return { row: { line: [span(` ${modal.question} [y/N]`, { fg: Color.yellow, bold: true })] }, cursor: null };
    }
    if (modal?.kind === "prompt") {
      const field = this.field(` ${modal.label}: `, modal.input, width, y);
      return { row: { line: field.line }, cursor: field.cursor };
    }
    if (this.message && this.message.until > Date.now()) {
      return { row: { line: [span(` ${truncate(printable(this.message.text), width - 1)}`, Styles.bold)] }, cursor: null };
    }
    const hints =
      modal?.kind === "find"
        ? "enter open · esc close"
        : modal?.kind === "help"
          ? "any key closes"
          : `${this.views[this.active].hints()} · ? keys`;
    return { row: { line: [span(` ${hints}`, Styles.dim)] }, cursor: null };
  }

  private helpRows(): Row[] {
    const keys = [...this.views[this.active].keys(), ...GLOBAL_KEYS];
    const column = Math.max(...keys.map(([key]) => stringWidth(key))) + 2;
    return [
      { line: [span(" KEYS", Styles.bold)] },
      ...keys.map(([key, action]) => ({
        line: [span(` ${key}${" ".repeat(column - stringWidth(key))}`, Styles.accent), span(action)],
      })),
    ];
  }

  redraw(): void {
    const width = this.term.columns();
    const height = this.term.rows();
    const body = Math.max(0, height - 3);
    const rows: Row[] = [{ line: this.tabsLine() }];
    let cursor: Cursor | null = null;

    if (this.modal?.kind === "find") {
      const find = this.modal;
      const field = this.field(" / ", find.input, width, 1);
      rows.push({ line: field.line });
      cursor = field.cursor;
      if (find.files === null) {
        rows.push({ line: [span(" Listing files…", Styles.dim)] });
      } else if (find.matches.length === 0) {
        rows.push({ line: [span(" No matching files", Styles.dim)] });
      } else {
        find.list.reveal(find.matches.length, body);
        find.matches.slice(find.list.scroll, find.list.scroll + body).forEach((match, offset) => {
          const name = path.basename(match);
          const dir = path.dirname(match);
          rows.push({
            line: [span(` ${printable(name)}`), span(dir === "." ? "" : `  ${printable(dir)}`, Styles.dim)],
            override: find.list.scroll + offset === find.list.selected ? Styles.selected : undefined,
          });
        });
      }
    } else if (this.modal?.kind === "help") {
      rows.push(...this.helpRows().slice(0, body + 1));
    } else {
      const view = this.views[this.active];
      rows.push({ line: view.header(width) }, ...view.rows(width, body));
    }

    while (rows.length < height - 1) rows.push({ line: [] });
    const footer = this.footer(width, height - 1);
    rows[height - 1] = footer.row;
    this.screen.draw(rows, width, height, footer.cursor ?? cursor);
  }
}

export function runSidebar(): void {
  // herdr starts the pane in the plugin's own folder; the folder to show
  // comes from the launcher.
  const root = process.env.RAIL_CWD || process.cwd();
  new App(path.resolve(root)).start();
}
