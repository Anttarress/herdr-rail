// Styled lines and a row-diffing renderer.
//
// Colors are the 16 ANSI colors on purpose: they follow the terminal theme,
// so the sidebar matches whatever herdr theme the user picked.

import { fit } from "./width.ts";

export const Color = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7, gray: 8,
  brightRed: 9, brightGreen: 10, brightYellow: 11, brightBlue: 12, brightMagenta: 13, brightCyan: 14, brightWhite: 15,
} as const;

export interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Span {
  text: string;
  style?: Style;
}

export type Line = Span[];

export function span(text: string, style?: Style): Span {
  return { text, style };
}

function colorCode(color: number, background: boolean): string {
  if (color < 8) return String((background ? 40 : 30) + color);
  if (color < 16) return String((background ? 100 : 90) + color - 8);
  return `${background ? 48 : 38};5;${color}`;
}

function sgr(style: Style): string {
  const codes = ["0"];
  if (style.bold) codes.push("1");
  if (style.dim) codes.push("2");
  if (style.italic) codes.push("3");
  if (style.underline) codes.push("4");
  if (style.inverse) codes.push("7");
  if (style.fg !== undefined) codes.push(colorCode(style.fg, false));
  if (style.bg !== undefined) codes.push(colorCode(style.bg, true));
  return `\x1b[${codes.join(";")}m`;
}

/**
 * Render a line to exactly `width` columns. `override` replaces every span's
 * style (a selected row is drawn in one style, whatever its spans say).
 */
export function renderLine(line: Line, width: number, override?: Style): string {
  let out = "";
  let used = 0;
  for (const part of line) {
    if (used >= width) break;
    const piece = fit(part.text, width - used);
    if (!piece.text) continue;
    out += sgr(override ?? part.style ?? {}) + piece.text;
    used += piece.width;
  }
  if (used < width) out += sgr(override ?? {}) + " ".repeat(width - used);
  return `${out}\x1b[0m`;
}

/** Plain text of a line, for tests and logs. */
export function lineText(line: Line): string {
  return line.map((part) => part.text).join("");
}

export interface Row {
  line: Line;
  /** Draw the whole row in this style. */
  override?: Style;
}

export interface Cursor {
  x: number;
  y: number;
}

export class Screen {
  private previous: string[] = [];
  private size = "";
  private readonly write: (data: string) => void;

  constructor(write: (data: string) => void) {
    this.write = write;
  }

  /** Forget what is on screen; the next draw repaints everything. */
  invalidate(): void {
    this.previous = [];
  }

  draw(rows: Row[], columns: number, height: number, cursor: Cursor | null): void {
    const size = `${columns}x${height}`;
    if (size !== this.size) {
      this.size = size;
      this.previous = [];
    }
    let out = "";
    for (let y = 0; y < height; y += 1) {
      const row = rows[y];
      const rendered = renderLine(row?.line ?? [], columns, row?.override);
      if (rendered === this.previous[y]) continue;
      this.previous[y] = rendered;
      out += `\x1b[${y + 1};1H${rendered}`;
    }
    out += cursor ? `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h` : "\x1b[?25l";
    this.write(out);
  }
}
