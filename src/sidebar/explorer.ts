// The file tree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoStatus } from "../git.ts";
import type { KeyEvent } from "../tui/keys.ts";
import { span, type Line, type Row, type Style } from "../tui/screen.ts";
import { ListState } from "../tui/widgets.ts";
import { printable, stringWidth, truncate } from "../tui/width.ts";
import { statusBadge, Styles, type Host, type View } from "./view.ts";

/** A folder with more entries than this shows the first ones and a count. */
const MAX_ENTRIES = 500;
/** Never listed, hidden files on or off. */
const ALWAYS_HIDDEN = new Set([".git", ".DS_Store"]);

interface TreeRow {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  open: boolean;
  /** A placeholder such as "… 120 more", not a file. */
  note: boolean;
}

interface Entry {
  name: string;
  dir: boolean;
}

export function listDir(dir: string, showHidden: boolean): Entry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable or gone
  }
  const entries: Entry[] = [];
  for (const dirent of dirents) {
    if (ALWAYS_HIDDEN.has(dirent.name) || (!showHidden && dirent.name.startsWith("."))) continue;
    let isDir = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, dirent.name)).isDirectory();
      } catch {
        // A dangling link is listed as a file.
      }
    }
    entries.push({ name: dirent.name, dir: isDir });
  }
  return entries.sort(
    (a, b) =>
      Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export function displayPath(dir: string): string {
  const home = os.homedir();
  if (dir === home) return "~";
  return dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
}

export class Explorer implements View {
  private readonly host: Host;
  private root: string;
  private readonly open = new Set<string>();
  private tree: TreeRow[] = [];
  private readonly list = new ListState();
  private height = 1;
  /** Absolute path → badge, for changed files. */
  private badges = new Map<string, { letter: string; style: Style }>();
  /** Folders with a change somewhere below them. */
  private dirty = new Set<string>();

  constructor(host: Host, root: string) {
    this.host = host;
    this.root = root;
    this.reload();
  }

  tab(): string {
    return "Files";
  }

  setRoot(root: string): void {
    if (root === this.root) return;
    this.root = root;
    this.list.selected = 0;
    this.list.scroll = 0;
    this.reload();
  }

  setStatus(status: RepoStatus | null): void {
    this.badges = new Map();
    this.dirty = new Set();
    if (!status) return;
    for (const entry of status.entries) {
      const file = path.join(status.root, entry.path);
      this.badges.set(file, statusBadge(entry, entry.worktree === "." && !entry.untracked));
      for (let dir = path.dirname(file); dir.length >= status.root.length; dir = path.dirname(dir)) {
        if (this.dirty.has(dir)) break;
        this.dirty.add(dir);
        if (dir === path.dirname(dir)) break;
      }
    }
  }

  /** Re-read every open folder, keeping the selection on the same path. */
  reload(): void {
    const selected = this.tree[this.list.selected]?.path;
    const showHidden = this.host.settings().showHidden;
    const rows: TreeRow[] = [];
    const walk = (dir: string, depth: number) => {
      const entries = listDir(dir, showHidden);
      for (const entry of entries.slice(0, MAX_ENTRIES)) {
        const file = path.join(dir, entry.name);
        const open = entry.dir && this.open.has(file);
        rows.push({ path: file, name: entry.name, dir: entry.dir, depth, open, note: false });
        if (open) walk(file, depth + 1);
      }
      if (entries.length > MAX_ENTRIES) {
        const more = `… ${entries.length - MAX_ENTRIES} more`;
        rows.push({ path: dir, name: more, dir: false, depth, open: false, note: true });
      }
    };
    walk(this.root, 0);
    this.tree = rows;
    const index = selected ? rows.findIndex((row) => row.path === selected && !row.note) : -1;
    if (index >= 0) this.list.selected = index;
    this.list.clamp(rows.length);
  }

  header(width: number): Line {
    const name = path.basename(this.root) || this.root;
    const where = displayPath(path.dirname(this.root));
    const title = truncate(printable(name.toUpperCase()), width - 1);
    return [span(` ${title}`, Styles.bold), span(`  ${where}`, Styles.dim)];
  }

  rows(width: number, height: number): Row[] {
    this.height = height;
    if (this.tree.length === 0) return [{ line: [span(" (empty folder)", Styles.dim)] }];
    this.list.reveal(this.tree.length, height);
    return this.tree.slice(this.list.scroll, this.list.scroll + height).map((row, offset) => {
      const selected = this.list.scroll + offset === this.list.selected;
      return { line: this.line(row, width), override: selected ? Styles.selected : undefined };
    });
  }

  private line(row: TreeRow, width: number): Line {
    const lead = ` ${"  ".repeat(row.depth)}${row.dir ? (row.open ? "▾ " : "▸ ") : "  "}`;
    if (row.note) return [span(lead + row.name, Styles.dim)];
    const badge = row.dir
      ? this.dirty.has(row.path)
        ? { letter: "•", style: Styles.modified }
        : undefined
      : this.badges.get(row.path);
    const room = width - stringWidth(lead) - (badge ? 3 : 1);
    const name = truncate(printable(row.name), Math.max(1, room));
    const line: Line = [span(lead, Styles.dim), span(name, row.dir ? Styles.accent : badge?.style)];
    if (badge) {
      line.push(span(" ".repeat(Math.max(1, room - stringWidth(name) + 1))), span(badge.letter, badge.style));
    }
    return line;
  }

  private current(): TreeRow | undefined {
    const row = this.tree[this.list.selected];
    return row && !row.note ? row : undefined;
  }

  private toggle(row: TreeRow, open: boolean): void {
    if (open) this.open.add(row.path);
    else this.open.delete(row.path);
    this.reload();
  }

  private activate(row: TreeRow): void {
    if (row.dir) this.toggle(row, !row.open);
    else this.host.preview({ kind: "file", path: row.path });
  }

  key(event: KeyEvent): boolean {
    if (event.ctrl || event.alt) return false;
    if (this.list.navigate(event, this.tree.length, Math.max(1, this.height - 1))) return true;
    const row = this.current();
    switch (event.name) {
      case "enter":
      case " ":
      case "o":
        if (row) this.activate(row);
        return true;
      case "right":
      case "l":
        if (row?.dir && !row.open) this.toggle(row, true);
        else if (row?.dir) this.list.move(1, this.tree.length);
        return true;
      case "left":
      case "h":
        if (row?.dir && row.open) {
          this.toggle(row, false);
        } else if (row) {
          const parent = this.tree.findIndex((entry) => entry.path === path.dirname(row.path) && !entry.note);
          if (parent >= 0) this.list.selected = parent;
        }
        return true;
      case ".":
        this.host.updateSettings({ showHidden: !this.host.settings().showHidden });
        this.reload();
        this.host.flash(this.host.settings().showHidden ? "Showing hidden files" : "Hiding hidden files");
        return true;
      case "-":
      case "backspace":
        this.host.setRoot(path.dirname(this.root));
        return true;
      case "y":
        if (row) {
          this.host.copy(path.relative(this.root, row.path));
          this.host.flash("Copied path");
        }
        return true;
      default:
        return false;
    }
  }

  click(index: number, double: boolean): void {
    const target = this.list.scroll + index;
    const row = this.tree[target];
    if (!row || row.note) return;
    this.list.selected = target;
    // A folder opens on one click; a file needs two, as its preview takes over the tab bar.
    if (row.dir || double) this.activate(row);
  }

  scroll(delta: number): void {
    const max = Math.max(0, this.tree.length - this.height);
    this.list.scroll = Math.max(0, Math.min(max, this.list.scroll + delta));
    // Keep the selection on screen so the next draw does not scroll back.
    this.list.selected = Math.max(this.list.scroll, Math.min(this.list.selected, this.list.scroll + this.height - 1));
    this.list.clamp(this.tree.length);
  }

  hints(): string {
    return "enter open · / find";
  }

  keys(): [string, string][] {
    return [
      ["↑↓ j k", "move"],
      ["←→ h l", "fold, unfold"],
      ["enter", "open folder or file"],
      ["/", "find a file"],
      [".", "hidden files on/off"],
      ["-", "parent folder"],
      ["y", "copy path"],
    ];
  }
}
