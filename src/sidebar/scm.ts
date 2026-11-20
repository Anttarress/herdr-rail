// Source control: staged and unstaged changes, commit, push and pull.

import path from "node:path";
import * as git from "../git.ts";
import type { RepoStatus, StatusEntry } from "../git.ts";
import type { KeyEvent } from "../tui/keys.ts";
import { span, type Line, type Row } from "../tui/screen.ts";
import { ListState } from "../tui/widgets.ts";
import { printable, stringWidth, truncate } from "../tui/width.ts";
import { statusBadge, Styles, type Host, type View } from "./view.ts";

type ScmRow =
  | { kind: "message" }
  | { kind: "section"; title: string; group: Group; count: number }
  | { kind: "file"; entry: StatusEntry; group: Group }
  | { kind: "note"; text: string };

type Group = "conflicts" | "staged" | "changes";

const DRAFT_PROMPT =
  "Summarise the staged diff on stdin as a git commit subject: imperative mood, at most 72 characters, " +
  "plain text without quotes or a final period. Output that single line and nothing else.";
const DRAFT_MAX_DIFF_BYTES = 16 * 1024;
/** One-shot, no MCP servers to start, and no transcript left behind. */
const DRAFT_ARGS = ["-p", "--model", "haiku", "--strict-mcp-config", "--no-session-persistence", DRAFT_PROMPT];

/** The reply line of `claude -p`, without the quotes or fences a model may add. */
export function cleanDraft(reply: string): string | null {
  const line = reply
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("```"))
    .pop();
  const message = (line ?? "").replace(/^["'`]+|["'`]+$/g, "").replace(/\.$/, "").trim();
  return message || null;
}

export function buildRows(status: RepoStatus | null): ScmRow[] {
  if (!status) return [{ kind: "note", text: "Not a git repository" }];
  const rows: ScmRow[] = [{ kind: "message" }];
  const groups: [Group, string, StatusEntry[]][] = [
    ["conflicts", "Merge Conflicts", status.entries.filter((entry) => entry.conflict)],
    ["staged", "Staged Changes", status.entries.filter(git.isStaged)],
    ["changes", "Changes", status.entries.filter(git.isUnstaged)],
  ];
  for (const [group, title, entries] of groups) {
    if (entries.length === 0) continue;
    rows.push({ kind: "section", title, group, count: entries.length });
    for (const entry of entries) rows.push({ kind: "file", entry, group });
  }
  if (rows.length === 1) rows.push({ kind: "note", text: "No changes" });
  return rows;
}

export class SourceControl implements View {
  private readonly host: Host;
  private status: RepoStatus | null = null;
  private list_: ScmRow[] = buildRows(null);
  private readonly list = new ListState();
  private height = 1;
  private draft = "";
  /** A label while a git command or a draft is running; keys that change the repo wait. */
  private busy: string | null = null;

  constructor(host: Host) {
    this.host = host;
  }

  tab(): string {
    const count = this.status?.entries.length ?? 0;
    return count > 0 ? `Git ${count}` : "Git";
  }

  setStatus(status: RepoStatus | null): void {
    const selected = this.list_[this.list.selected];
    const key = selected?.kind === "file" ? `${selected.group}:${selected.entry.path}` : null;
    this.status = status;
    this.list_ = buildRows(status);
    const index = key
      ? this.list_.findIndex((row) => row.kind === "file" && `${row.group}:${row.entry.path}` === key)
      : -1;
    if (index >= 0) this.list.selected = index;
    this.list.clamp(this.list_.length);
  }

  header(width: number): Line {
    if (!this.status) return [span(" SOURCE CONTROL", Styles.bold)];
    const { branch, ahead, behind, upstream } = this.status;
    const sync = `${ahead ? ` ↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}${upstream ? "" : " (no upstream)"}`;
    const name = truncate(printable(branch || "(detached)"), Math.max(4, width - stringWidth(sync) - 4));
    return [span(`  ${name}`, Styles.bold), span(sync, Styles.dim), span(this.busy ? `  ${this.busy}` : "", Styles.dim)];
  }

  rows(width: number, height: number): Row[] {
    this.height = height;
    this.list.reveal(this.list_.length, height);
    return this.list_.slice(this.list.scroll, this.list.scroll + height).map((row, offset) => {
      const selected = this.list.scroll + offset === this.list.selected;
      return { line: this.line(row, width), override: selected ? Styles.selected : undefined };
    });
  }

  private line(row: ScmRow, width: number): Line {
    switch (row.kind) {
      case "message":
        return this.draft
          ? [span(" ✎ ", Styles.dim), span(truncate(printable(this.draft), width - 4))]
          : [span(" ✎ Message (c to write)", Styles.dim)];
      case "section":
        return [span(` ${row.title}`, Styles.bold), span(` ${row.count}`, Styles.dim)];
      case "note":
        return [span(` ${row.text}`, Styles.dim)];
      case "file": {
        const badge = statusBadge(row.entry, row.group === "staged");
        const name = printable(path.basename(row.entry.path));
        const dir = path.dirname(row.entry.path);
        const shown = truncate(name, Math.max(1, width - 5));
        const rest = width - 5 - stringWidth(shown);
        const line: Line = [span(`  ${badge.letter} `, badge.style), span(shown)];
        if (dir !== "." && rest > 3) line.push(span(` ${truncate(printable(dir), rest - 1)}`, Styles.dim));
        return line;
      }
    }
  }

  private current(): ScmRow | undefined {
    return this.list_[this.list.selected];
  }

  private stagedCount(): number {
    return this.status?.entries.filter(git.isStaged).length ?? 0;
  }

  /** Run a git command that changes the repository, then show its outcome. */
  private async mutate(label: string, action: (root: string) => Promise<git.GitResult>, done?: string): Promise<boolean> {
    if (!this.status || this.busy) return false;
    this.busy = label;
    this.host.redraw();
    const result = await action(this.status.root);
    this.busy = null;
    if (!result.ok) this.host.flash(git.failure(result));
    else if (done) this.host.flash(done);
    await this.host.refresh();
    return result.ok;
  }

  private toggleStage(row: ScmRow): void {
    if (row.kind === "file") {
      const paths = [row.entry.path];
      if (row.group === "staged") void this.mutate("unstaging…", (root) => git.unstage(root, paths));
      else void this.mutate("staging…", (root) => git.stage(root, paths));
    } else if (row.kind === "section") {
      if (row.group === "staged") void this.mutate("unstaging…", git.unstageAll);
      else void this.mutate("staging…", git.stageAll);
    } else if (row.kind === "message") {
      this.editMessage();
    }
  }

  private openDiff(row: ScmRow): void {
    if (row.kind !== "file" || !this.status) return;
    this.host.preview({
      kind: "diff",
      root: this.status.root,
      path: row.entry.path,
      staged: row.group === "staged",
      untracked: row.entry.untracked,
    });
  }

  private editMessage(): void {
    this.host.prompt(
      "Commit",
      this.draft,
      (value) => {
        this.draft = value.trim();
        this.commit();
      },
      (value) => {
        this.draft = value.trim(); // Esc keeps what was typed
      },
    );
  }

  private commit(): void {
    if (!this.draft) {
      this.host.flash("Commit message is empty");
    } else if (this.stagedCount() === 0) {
      this.host.flash("Nothing staged — press a to stage everything");
    } else {
      const message = this.draft;
      void this.mutate("committing…", (root) => git.commit(root, message), "Committed").then((ok) => {
        if (ok) this.draft = "";
        this.host.redraw();
      });
    }
  }

  private discard(row: ScmRow): void {
    if (row.kind !== "file" || row.group !== "changes") {
      this.host.flash("Select an unstaged change to discard");
      return;
    }
    const { entry } = row;
    const what = entry.untracked ? "Delete untracked" : "Discard changes to";
    this.host.confirm(`${what} ${path.basename(entry.path)}?`, () => {
      void this.mutate("discarding…", (root) => git.discard(root, entry), "Discarded");
    });
  }

  private async draftMessage(): Promise<void> {
    if (!this.status || this.busy) return;
    if (this.stagedCount() === 0) {
      this.host.flash("Stage changes first — the draft describes what is staged");
      return;
    }
    this.busy = "drafting…";
    this.host.redraw();
    const { root } = this.status;
    const input = await git.stagedDiff(root, DRAFT_MAX_DIFF_BYTES);
    const reply = await git.run("claude", DRAFT_ARGS, root, {
      input,
      timeoutMs: 60_000,
    });
    this.busy = null;
    const message = reply.ok ? cleanDraft(reply.stdout) : null;
    if (!message) {
      this.host.flash("Could not draft a message (is the claude CLI installed?)");
      this.host.redraw();
      return;
    }
    this.draft = message;
    this.editMessage();
    this.host.redraw();
  }

  key(event: KeyEvent): boolean {
    if (event.ctrl || event.alt) return false;
    if (this.list.navigate(event, this.list_.length, Math.max(1, this.height - 1))) return true;
    const row = this.current();
    switch (event.name) {
      case "enter":
      case " ":
        if (row) this.toggleStage(row);
        return true;
      case "o":
      case "right":
      case "l":
        if (row) this.openDiff(row);
        return true;
      case "a":
        void this.mutate("staging…", git.stageAll);
        return true;
      case "u":
        void this.mutate("unstaging…", git.unstageAll);
        return true;
      case "d":
        if (row) this.discard(row);
        return true;
      case "c":
        this.editMessage();
        return true;
      case "A":
        void this.draftMessage();
        return true;
      case "P":
        this.host.confirm("Push to the remote?", () => void this.mutate("pushing…", git.push, "Pushed"));
        return true;
      case "L":
        this.host.confirm("Pull (fast-forward only)?", () => void this.mutate("pulling…", git.pull, "Pulled"));
        return true;
      default:
        return false;
    }
  }

  click(index: number, double: boolean): void {
    const target = this.list.scroll + index;
    const row = this.list_[target];
    if (!row) return;
    this.list.selected = target;
    if (row.kind === "message") this.editMessage();
    else if (double) this.openDiff(row);
  }

  scroll(delta: number): void {
    const max = Math.max(0, this.list_.length - this.height);
    this.list.scroll = Math.max(0, Math.min(max, this.list.scroll + delta));
    this.list.selected = Math.max(this.list.scroll, Math.min(this.list.selected, this.list.scroll + this.height - 1));
    this.list.clamp(this.list_.length);
  }

  hints(): string {
    return "enter stage · c commit";
  }

  keys(): [string, string][] {
    return [
      ["enter", "stage, unstage"],
      ["o", "open diff"],
      ["a  u", "stage all, unstage all"],
      ["d", "discard change"],
      ["c", "message and commit"],
      ["A", "draft message (claude)"],
      ["P  L", "push, pull"],
    ];
  }
}
