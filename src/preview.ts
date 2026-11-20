// The preview pane: a read-only viewer for one file or one diff. The sidebar
// names what to show in a control file; the preview watches that file, so
// opening another file reuses the same tab.

import fs from "node:fs";
import path from "node:path";
import { TOKEN_TTL_MS } from "./dock.ts";
import * as git from "./git.ts";
import { call, PLUGIN_ID, snapshot as takeSnapshot, type PaneInfo } from "./herdr.ts";
import { highlightLine, languageFor } from "./highlight.ts";
import { TOKEN_PREVIEW } from "./naming.ts";
import { readJson } from "./settings.ts";
import { displayPath } from "./sidebar/explorer.ts";
import { Styles, type PreviewTarget } from "./sidebar/view.ts";
import type { InputEvent } from "./tui/keys.ts";
import { Color, Screen, span, type Line, type Row, type Span, type Style } from "./tui/screen.ts";
import { openTerminal, type Terminal } from "./tui/term.ts";
import { printable, skipColumns, stringWidth, truncate } from "./tui/width.ts";

const POLL_MS = 500;
const DIFF_RELOAD_POLLS = 4;
const HEARTBEAT_POLLS = 16;
/** Larger files show their first part. */
const MAX_BYTES = 2 * 1024 * 1024;
const PAN_COLUMNS = 8;

interface Control {
  target?: PreviewTarget;
  /** The sidebar pane that asked; focus returns there on close. */
  origin?: string;
}

interface DocLine {
  gutter: string;
  spans: Span[];
}

export interface Doc {
  /** Tab label and header. */
  name: string;
  detail: string;
  lines: DocLine[];
  /** Shown instead of lines (binary file, missing file, empty diff). */
  notice?: string;
}

const DIFF_STYLE = {
  header: { bold: true, dim: true },
  hunk: { fg: Color.cyan },
  added: { fg: Color.green },
  removed: { fg: Color.red },
} as const satisfies Record<string, Style>;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileDoc(file: string): Doc {
  const doc: Doc = { name: path.basename(file), detail: displayPath(path.dirname(file)), lines: [] };
  let size: number;
  let bytes: Buffer;
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return { ...doc, notice: "This is a folder" };
    size = stat.size;
    const handle = fs.openSync(file, "r");
    try {
      bytes = Buffer.alloc(Math.min(size, MAX_BYTES));
      fs.readSync(handle, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "it no longer exists" : code === "EACCES" ? "permission denied" : (code ?? "read error");
    return { ...doc, notice: `Cannot show this file: ${why}` };
  }
  if (bytes.subarray(0, 8192).includes(0)) return { ...doc, notice: `Binary file · ${formatSize(size)}` };
  if (bytes.length === 0) return { ...doc, notice: "Empty file" };

  const text = bytes.toString("utf8");
  const raw = text.split(/\r?\n/);
  if (raw[raw.length - 1] === "") raw.pop();
  const lang = languageFor(file);
  const digits = String(raw.length).length;
  let inBlock = false;
  doc.lines = raw.map((line, index) => {
    const safe = printable(line);
    let spans = [span(safe)];
    if (lang) ({ spans, inBlock } = highlightLine(safe, lang, inBlock));
    return { gutter: `${String(index + 1).padStart(digits)} `, spans };
  });
  if (size > MAX_BYTES) {
    doc.lines.push({ gutter: "", spans: [span(`… first ${formatSize(MAX_BYTES)} of ${formatSize(size)}`, Styles.dim)] });
  }
  return doc;
}

/** Style a unified diff. File headers run up to the first hunk; inside a hunk the first column decides. */
export function diffLines(raw: string): DocLine[] {
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let inHunk = false;
  return lines.map((line) => {
    let style: Style | undefined;
    if (line.startsWith("diff ")) inHunk = false;
    if (line.startsWith("@@")) {
      inHunk = true;
      style = DIFF_STYLE.hunk;
    } else if (!inHunk) {
      style = DIFF_STYLE.header;
    } else if (line.startsWith("+")) {
      style = DIFF_STYLE.added;
    } else if (line.startsWith("-")) {
      style = DIFF_STYLE.removed;
    } else if (line.startsWith("\\")) {
      style = Styles.dim;
    }
    return { gutter: "", spans: [span(printable(line), style)] };
  });
}

async function diffDoc(target: Extract<PreviewTarget, { kind: "diff" }>): Promise<Doc> {
  const doc: Doc = {
    name: path.basename(target.path),
    detail: `${target.staged ? "staged" : "working tree"} · ${target.path}`,
    lines: [],
  };
  const raw = await git.diff(target.root, target, target.staged);
  if (!raw.trim()) return { ...doc, notice: "No changes to show" };
  return { ...doc, lines: diffLines(raw) };
}

function loadDoc(target: PreviewTarget): Promise<Doc> {
  return target.kind === "diff" ? diffDoc(target) : Promise.resolve(fileDoc(target.path));
}

/** Drop the first `columns` columns across a run of spans. */
function panSpans(spans: Span[], columns: number): Span[] {
  if (columns <= 0) return spans;
  const out: Span[] = [];
  let left = columns;
  for (const part of spans) {
    const width = stringWidth(part.text);
    if (left >= width) {
      left -= width;
    } else {
      out.push(span(skipColumns(part.text, left), part.style));
      left = 0;
    }
  }
  return out;
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

class Preview {
  private readonly term: Terminal;
  private readonly screen: Screen;
  private readonly paneId = process.env.HERDR_PANE_ID ?? "";
  private readonly controlFile: string | undefined;
  private controlStamp = 0;
  private target: PreviewTarget | undefined;
  private origin: string | undefined;
  private doc: Doc = { name: "Preview", detail: "", lines: [], notice: "Nothing to preview" };
  private fileStamp = 0;
  private top = 0;
  private left = 0;
  private polls = 0;
  private tabId: string | undefined;
  private loading = false;
  /** Set while loading when another load was asked for; the value is that load's `fresh`. */
  private queued: boolean | null = null;

  constructor(controlFile: string | undefined, target: PreviewTarget | undefined) {
    this.controlFile = controlFile;
    this.target = target;
    this.term = openTerminal({ input: (event) => this.input(event), resize: () => this.draw() }, "herdr-rail preview");
    this.screen = new Screen((data) => this.term.write(data));
  }

  async start(): Promise<void> {
    this.draw();
    await this.stamp();
    if (this.controlFile) this.readControl();
    await this.load(true);
    setInterval(() => void this.poll(), POLL_MS);
  }

  private async stamp(): Promise<void> {
    if (!this.paneId) return;
    await call("pane.report_metadata", {
      pane_id: this.paneId,
      source: PLUGIN_ID,
      tokens: { [TOKEN_PREVIEW]: "1" },
      ttl_ms: TOKEN_TTL_MS,
    }).catch(() => undefined);
  }

  private readControl(): void {
    if (!this.controlFile) return;
    this.controlStamp = mtime(this.controlFile);
    const control = readJson<Control>(this.controlFile, {});
    if (control.target) this.target = control.target;
    this.origin = control.origin;
  }

  /** Load the target. A new target starts at the top; a reload keeps the scroll position. */
  private async load(fresh: boolean): Promise<void> {
    if (!this.target) return;
    if (this.loading) {
      // A load is in flight; run once more when it ends so the newest target wins.
      this.queued = this.queued === true || fresh;
      return;
    }
    this.loading = true;
    try {
      const target = this.target;
      this.doc = await loadDoc(target);
      this.fileStamp = target.kind === "file" ? mtime(target.path) : 0;
      if (fresh) {
        this.top = 0;
        this.left = 0;
        void this.labelTab(target);
      }
    } finally {
      this.loading = false;
    }
    this.draw();
    if (this.queued !== null) {
      const again = this.queued;
      this.queued = null;
      await this.load(again);
    }
  }

  /** Name the tab after the file. A label we set ourselves is left alone by auto tab naming. */
  private async labelTab(target: PreviewTarget): Promise<void> {
    if (!this.paneId) return;
    try {
      this.tabId ??= (await call<{ pane: PaneInfo }>("pane.get", { pane_id: this.paneId })).pane.tab_id;
      const glyph = target.kind === "diff" ? "±" : "◇";
      await call("tab.rename", { tab_id: this.tabId, label: `${glyph} ${truncate(this.doc.name, 24)}` });
    } catch {
      // Cosmetic; the preview works without its label.
    }
  }

  private async poll(): Promise<void> {
    this.polls += 1;
    if (this.polls % HEARTBEAT_POLLS === 0) await this.stamp();
    if (this.controlFile && mtime(this.controlFile) !== this.controlStamp) {
      this.readControl();
      await this.load(true);
    } else if (this.target?.kind === "file" && mtime(this.target.path) !== this.fileStamp) {
      await this.load(false);
    } else if (this.target?.kind === "diff" && this.polls % DIFF_RELOAD_POLLS === 0) {
      await this.load(false);
    }
  }

  private async close(): Promise<void> {
    // Hand focus back to the sidebar that opened this before the tab goes
    // away, but only if this tab is the one on screen: focusing a pane
    // switches to its tab.
    try {
      const snap = await takeSnapshot();
      const mine = snap.panes.find((pane) => pane.pane_id === this.paneId);
      if (this.origin && mine && snap.focused_tab_id === mine.tab_id) {
        await call("pane.focus", { pane_id: this.origin }, 1500);
      }
    } catch {
      // herdr picks where focus goes.
    }
    this.term.close();
    process.exit(0);
  }

  private bodyHeight(): number {
    return Math.max(1, this.term.rows() - 2);
  }

  private scrollTo(top: number): void {
    const max = Math.max(0, this.doc.lines.length - this.bodyHeight());
    this.top = Math.max(0, Math.min(max, top));
  }

  private input(event: InputEvent): void {
    const page = Math.max(1, this.bodyHeight() - 1);
    if (event.type === "mouse") {
      if (event.action === "wheel-up") this.scrollTo(this.top - 3);
      if (event.action === "wheel-down") this.scrollTo(this.top + 3);
    } else if (event.type === "key") {
      if (event.name === "q" || event.name === "escape" || (event.ctrl && (event.name === "c" || event.name === "q"))) {
        void this.close();
        return;
      }
      switch (event.name) {
        case "up":
        case "k":
          this.scrollTo(this.top - 1);
          break;
        case "down":
        case "j":
          this.scrollTo(this.top + 1);
          break;
        case "pageup":
        case "b":
          this.scrollTo(this.top - page);
          break;
        case "pagedown":
        case " ":
          this.scrollTo(this.top + page);
          break;
        case "home":
        case "g":
          this.scrollTo(0);
          break;
        case "end":
        case "G":
          this.scrollTo(this.doc.lines.length);
          break;
        case "left":
        case "h":
          this.left = Math.max(0, this.left - PAN_COLUMNS);
          break;
        case "right":
        case "l":
          this.left += PAN_COLUMNS;
          break;
        case "r":
          void this.load(false);
          break;
        default:
          break;
      }
    }
    this.draw();
  }

  private draw(): void {
    const width = this.term.columns();
    const height = this.term.rows();
    const body = this.bodyHeight();
    this.scrollTo(this.top);
    const rows: Row[] = [
      { line: [span(` ${printable(this.doc.name)}`, Styles.bold), span(`  ${printable(this.doc.detail)}`, Styles.dim)] },
    ];
    if (this.doc.notice) {
      rows.push({ line: [] }, { line: [span(`  ${this.doc.notice}`, Styles.dim)] });
    } else {
      for (const line of this.doc.lines.slice(this.top, this.top + body)) {
        const text: Line = [span(line.gutter, Styles.dim), ...panSpans(line.spans, this.left)];
        rows.push({ line: text });
      }
    }
    while (rows.length < height - 1) rows.push({ line: [] });
    const total = this.doc.lines.length;
    const position = total > 0 ? `${this.top + 1}-${Math.min(total, this.top + body)}/${total}  ` : "";
    rows[height - 1] = { line: [span(` ${position}q close · ↑↓ scroll · ←→ pan · g/G ends`, Styles.dim)] };
    this.screen.draw(rows, width, height, null);
  }
}

export async function runPreview(args: string[]): Promise<void> {
  // `herdr-rail preview <file>` works on its own; inside herdr the sidebar supplies the control file.
  const direct: PreviewTarget | undefined = args[0] ? { kind: "file", path: path.resolve(args[0]) } : undefined;
  await new Preview(process.env.RAIL_PREVIEW_CTL, direct).start();
}
