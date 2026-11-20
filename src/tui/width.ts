// Terminal column widths. A compact approximation of wcwidth: zero for
// control and combining characters, two for CJK and emoji, one otherwise.

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [low, high] of ranges) {
    if (cp >= low && cp <= high) return true;
  }
  return false;
}

const ZERO_WIDTH: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670],
  [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
];

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) as number);
  return width;
}

/** The longest prefix of `text` that fits in `width` columns. */
export function fit(text: string, width: number): { text: string; width: number } {
  let used = 0;
  let end = 0;
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) as number);
    if (used + w > width) break;
    used += w;
    end += char.length;
  }
  return { text: end === text.length ? text : text.slice(0, end), width: used };
}

export function truncate(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return fit(text, width).text;
  return `${fit(text, width - 1).text}…`;
}

/** Drop the first `columns` columns of `text` (horizontal scrolling). */
export function skipColumns(text: string, columns: number): string {
  if (columns <= 0) return text;
  let used = 0;
  let start = 0;
  for (const char of text) {
    if (used >= columns) break;
    used += charWidth(char.codePointAt(0) as number);
    start += char.length;
  }
  return text.slice(start);
}

/** Make text safe to draw: expand tabs, replace other control characters. */
export function printable(text: string, tabWidth = 4): string {
  if (!/[\u0000-\u001f\u007f-\u009f]/.test(text)) return text;
  let out = "";
  let column = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) as number;
    if (char === "\t") {
      const pad = tabWidth - (column % tabWidth);
      out += " ".repeat(pad);
      column += pad;
    } else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
      out += "·";
      column += 1;
    } else {
      out += char;
      column += charWidth(cp);
    }
  }
  return out;
}
