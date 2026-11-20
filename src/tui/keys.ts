// Decodes terminal input (keys, SGR mouse reports, bracketed paste) into events.

export interface KeyEvent {
  type: "key";
  /** A printable character as typed (`a`, `A`, `/`), or a name such as `enter`, `up`, `f8`. */
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Present when the key inserts text. */
  text?: string;
}

export interface MouseEvent {
  type: "mouse";
  action: "down" | "up" | "drag" | "wheel-up" | "wheel-down";
  button: number;
  /** Zero-based cell. */
  x: number;
  y: number;
}

export interface PasteEvent {
  type: "paste";
  text: string;
}

export type InputEvent = KeyEvent | MouseEvent | PasteEvent;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CSI_FINAL: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab" };
const CSI_TILDE: Record<number, string> = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11",
  24: "f12",
};
const SS3_FINAL: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4",
};

function key(name: string, mods: Partial<Pick<KeyEvent, "ctrl" | "alt" | "shift" | "text">> = {}): KeyEvent {
  return { type: "key", name, ctrl: false, alt: false, shift: false, ...mods };
}

/** xterm encodes modifiers as 1 + (shift 1 | alt 2 | ctrl 4). */
function modifiers(param: number | undefined): Pick<KeyEvent, "ctrl" | "alt" | "shift"> {
  const bits = Math.max(0, (param ?? 1) - 1);
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

function mouse(params: string, final: string): MouseEvent | null {
  const [code, column, row] = params.slice(1).split(";").map(Number);
  if ([code, column, row].some((value) => !Number.isFinite(value))) return null;
  const base = { type: "mouse" as const, x: column - 1, y: row - 1, button: code & 3 };
  if (code & 64) return { ...base, action: code & 1 ? "wheel-down" : "wheel-up" };
  if (final === "m") return { ...base, action: "up" };
  return { ...base, action: code & 32 ? "drag" : "down" };
}

function csi(params: string, final: string): InputEvent | null {
  if (params.startsWith("<") && (final === "M" || final === "m")) return mouse(params, final);
  const numbers = params.split(";").map((part) => (part === "" ? undefined : Number(part)));
  if (final === "~") {
    const name = CSI_TILDE[numbers[0] ?? 0];
    return name ? key(name, modifiers(numbers[1])) : null;
  }
  if (final === "u" && numbers[0] !== undefined) {
    // Kitty keyboard protocol: code point ; modifiers.
    const mods = modifiers(numbers[1]);
    const named: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace" };
    const name = named[numbers[0]] ?? String.fromCodePoint(numbers[0]);
    return key(name, mods);
  }
  const name = CSI_FINAL[final];
  if (!name) return null;
  const mods = modifiers(numbers[1]);
  return key(name, final === "Z" ? { ...mods, shift: true } : mods);
}

function plain(char: string): KeyEvent {
  const code = char.codePointAt(0) as number;
  if (char === "\r" || char === "\n") return key("enter");
  if (char === "\t") return key("tab");
  if (code === 0x7f || code === 0x08) return key("backspace");
  if (code === 0) return key(" ", { ctrl: true });
  if (code < 0x20) return key(String.fromCharCode(code + 96), { ctrl: true });
  return key(char, { text: char });
}

export function parseInput(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i);
      const stop = end < 0 ? data.length : end;
      events.push({ type: "paste", text: data.slice(i + PASTE_START.length, stop) });
      i = end < 0 ? data.length : end + PASTE_END.length;
      continue;
    }
    const char = String.fromCodePoint(data.codePointAt(i) as number);
    if (char !== "\x1b") {
      events.push(plain(char));
      i += char.length;
      continue;
    }
    const next = data[i + 1];
    if (next === undefined) {
      events.push(key("escape"));
      i += 1;
    } else if (next === "[") {
      // Parameters and intermediates run until a final byte in @..~.
      let end = i + 2;
      while (end < data.length && (data.charCodeAt(end) < 0x40 || data.charCodeAt(end) > 0x7e)) end += 1;
      if (end >= data.length) break; // truncated sequence
      const event = csi(data.slice(i + 2, end), data[end]);
      if (event) events.push(event);
      i = end + 1;
    } else if (next === "O" && data[i + 2] !== undefined) {
      const name = SS3_FINAL[data[i + 2]];
      if (name) events.push(key(name));
      i += 3;
    } else if (next === "\x1b") {
      events.push(key("escape"));
      i += 1;
    } else {
      const following = String.fromCodePoint(data.codePointAt(i + 1) as number);
      events.push({ ...plain(following), alt: true, text: undefined });
      i += 1 + following.length;
    }
  }
  return events;
}
