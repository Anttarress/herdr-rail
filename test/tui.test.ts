import { describe, expect, test } from "bun:test";
import { highlightLine, languageFor } from "../src/highlight.ts";
import { diffLines } from "../src/preview.ts";
import { fuzzyFilter, fuzzyScore } from "../src/sidebar/fuzzy.ts";
import { parseInput, type KeyEvent } from "../src/tui/keys.ts";
import { lineText, renderLine, span } from "../src/tui/screen.ts";
import { ListState, TextInput } from "../src/tui/widgets.ts";
import { fit, printable, skipColumns, stringWidth, truncate } from "../src/tui/width.ts";

function keyNames(data: string): string[] {
  return parseInput(data).map((event) => {
    if (event.type !== "key") return event.type;
    return `${event.ctrl ? "ctrl+" : ""}${event.alt ? "alt+" : ""}${event.shift ? "shift+" : ""}${event.name}`;
  });
}

describe("parseInput", () => {
  test("printable characters, including multi-byte ones", () => {
    expect(keyNames("aZ/")).toEqual(["a", "Z", "/"]);
    expect(keyNames("é日😀")).toEqual(["é", "日", "😀"]);
  });

  test("control keys", () => {
    expect(keyNames("\r\t\x7f\x1b")).toEqual(["enter", "tab", "backspace", "escape"]);
    expect(keyNames("\x11\x03\x10")).toEqual(["ctrl+q", "ctrl+c", "ctrl+p"]);
  });

  test("arrows, paging and function keys", () => {
    expect(keyNames("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(keyNames("\x1bOA\x1b[H\x1b[F")).toEqual(["up", "home", "end"]);
    expect(keyNames("\x1b[5~\x1b[6~\x1b[3~\x1b[19~")).toEqual(["pageup", "pagedown", "delete", "f8"]);
  });

  test("modifiers", () => {
    expect(keyNames("\x1b[1;5C\x1b[1;2A\x1b[Z")).toEqual(["ctrl+right", "shift+up", "shift+tab"]);
    expect(keyNames("\x1bx")).toEqual(["alt+x"]);
  });

  test("a sequence followed by more input", () => {
    expect(keyNames("\x1b[Bj\x1b[A")).toEqual(["down", "j", "up"]);
  });

  test("SGR mouse reports use zero-based cells", () => {
    expect(parseInput("\x1b[<0;5;3M")).toEqual([{ type: "mouse", action: "down", button: 0, x: 4, y: 2 }]);
    expect(parseInput("\x1b[<0;5;3m")[0]).toMatchObject({ action: "up" });
    expect(parseInput("\x1b[<64;1;1M")[0]).toMatchObject({ action: "wheel-up" });
    expect(parseInput("\x1b[<65;1;1M")[0]).toMatchObject({ action: "wheel-down" });
    expect(parseInput("\x1b[<32;9;9M")[0]).toMatchObject({ action: "drag" });
  });

  test("bracketed paste arrives as one event", () => {
    expect(parseInput("\x1b[200~fix: a\nb\x1b[201~x")).toEqual([
      { type: "paste", text: "fix: a\nb" },
      { type: "key", name: "x", ctrl: false, alt: false, shift: false, text: "x" },
    ]);
  });

  test("unknown sequences are dropped, not typed", () => {
    expect(keyNames("\x1b[?1;2c")).toEqual([]);
    expect(keyNames("\x1b[I")).toEqual([]);
  });
});

describe("width", () => {
  test("counts columns, not characters", () => {
    expect(stringWidth("abc")).toBe(3);
    expect(stringWidth("日本")).toBe(4);
    expect(stringWidth("é")).toBe(1);
    expect(stringWidth("😀")).toBe(2);
  });

  test("fit never splits a wide character", () => {
    expect(fit("日本語", 5)).toEqual({ text: "日本", width: 4 });
    expect(fit("abc", 10)).toEqual({ text: "abc", width: 3 });
  });

  test("truncate adds an ellipsis within the width", () => {
    expect(truncate("configuration.ts", 8)).toBe("configu…");
    expect(stringWidth(truncate("日本語のファイル", 7))).toBeLessThanOrEqual(7);
    expect(truncate("ok", 8)).toBe("ok");
  });

  test("skipColumns pans text", () => {
    expect(skipColumns("abcdef", 2)).toBe("cdef");
    expect(skipColumns("abc", 9)).toBe("");
  });

  test("printable expands tabs to stops and hides control characters", () => {
    expect(printable("a\tb")).toBe("a   b");
    expect(printable("\tx")).toBe("    x");
    expect(printable("a\x1b[31mb")).toBe("a·[31mb");
  });
});

describe("renderLine", () => {
  const visible = (rendered: string) => rendered.replace(/\x1b\[[0-9;]*m/g, "");

  test("pads to the exact width", () => {
    expect(visible(renderLine([span("ab")], 6))).toBe("ab    ");
  });

  test("cuts spans that do not fit", () => {
    expect(visible(renderLine([span("abcd"), span("efgh")], 6))).toBe("abcdef");
  });

  test("pads instead of splitting a wide character at the edge", () => {
    expect(visible(renderLine([span("a日本")], 4))).toBe("a日 ");
  });

  test("an override styles the whole row", () => {
    const rendered = renderLine([span("a", { fg: 1 }), span("b")], 4, { inverse: true });
    expect(rendered).not.toContain("31");
    expect(rendered.match(/\x1b\[0;7m/g)?.length).toBe(3);
  });

  test("lineText joins spans", () => {
    expect(lineText([span("a"), span("b")])).toBe("ab");
  });
});

describe("TextInput", () => {
  const press = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({
    type: "key",
    name,
    ctrl: false,
    alt: false,
    shift: false,
    text: name.length === 1 && !mods.ctrl ? name : undefined,
    ...mods,
  });

  test("inserts at the cursor and deletes around it", () => {
    const input = new TextInput("fix bug");
    input.key(press("home"));
    input.key(press("X"));
    expect(input.value).toBe("Xfix bug");
    input.key(press("backspace"));
    input.key(press("delete"));
    expect(input.value).toBe("ix bug");
  });

  test("ctrl+w removes the word before the cursor, ctrl+u everything before it", () => {
    const input = new TextInput("add csv export");
    input.key(press("w", { ctrl: true }));
    expect(input.value).toBe("add csv ");
    input.key(press("u", { ctrl: true }));
    expect(input.value).toBe("");
  });

  test("pasted newlines become spaces", () => {
    const input = new TextInput();
    input.insert("one\ntwo");
    expect(input.value).toBe("one two");
  });

  test("the cursor column counts wide characters", () => {
    expect(new TextInput("日本").cursorColumn()).toBe(4);
  });
});

describe("ListState", () => {
  test("reveal scrolls only as far as needed", () => {
    const list = new ListState();
    list.selected = 12;
    list.reveal(50, 10);
    expect(list.scroll).toBe(3);
    list.selected = 1;
    list.reveal(50, 10);
    expect(list.scroll).toBe(1);
  });

  test("clamps to the list", () => {
    const list = new ListState();
    list.move(99, 5);
    expect(list.selected).toBe(4);
    list.move(-99, 5);
    expect(list.selected).toBe(0);
    list.clamp(0);
    expect(list.selected).toBe(0);
  });
});

describe("fuzzy matching", () => {
  test("needs every character in order", () => {
    expect(fuzzyScore("abc", "a/b/c.ts")).not.toBeNull();
    expect(fuzzyScore("abc", "cba")).toBeNull();
  });

  test("prefers a file-name match over a scattered path match", () => {
    const files = ["src/dock/layout.ts", "docs/overview.md", "src/dock.ts"];
    expect(fuzzyFilter("dock", files, 10)[0]).toBe("src/dock.ts");
  });

  test("an empty query lists files as they come, up to the limit", () => {
    expect(fuzzyFilter("", ["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});

describe("highlighting", () => {
  const kinds = (text: string, file: string, inBlock = false) => {
    const lang = languageFor(file);
    if (!lang) throw new Error(`no language for ${file}`);
    const result = highlightLine(text, lang, inBlock);
    return { parts: result.spans.map((part) => [part.text, part.style?.fg ?? null]), inBlock: result.inBlock };
  };

  test("keywords, strings, numbers and comments", () => {
    expect(kinds('const n = 42; // "note"', "a.ts").parts).toEqual([
      ["const", 5],
      [" n = ", null],
      ["42", 3],
      ["; ", null],
      ['// "note"', 8],
    ]);
  });

  test("a string keeps comment markers and escaped quotes inside it", () => {
    expect(kinds('"a // \\" b" x', "a.ts").parts).toEqual([
      ['"a // \\" b"', 2],
      [" x", null],
    ]);
  });

  test("block comments carry across lines", () => {
    const open = kinds("x /* start", "a.ts");
    expect(open.inBlock).toBe(true);
    const close = kinds("still */ y", "a.ts", true);
    expect(close.inBlock).toBe(false);
    expect(close.parts).toEqual([
      ["still */", 8],
      [" y", null],
    ]);
  });

  test("the text is never changed", () => {
    const text = "if (a) { return `x ${b}` } # not a comment here /* nor here";
    const lang = languageFor("a.ts");
    expect(highlightLine(text, lang!, false).spans.map((part) => part.text).join("")).toBe(text);
  });

  test("languages are picked by extension or file name", () => {
    expect(languageFor("Dockerfile")).not.toBeNull();
    expect(languageFor("x.py")?.lineComments).toEqual(["#"]);
    expect(languageFor("notes.txt")).toBeNull();
  });
});

describe("diffLines", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "--- a removed line that looks like a header",
    "+added",
    "",
  ].join("\n");

  test("styles by position: headers before the hunk, first column inside it", () => {
    const colors = diffLines(diff).map((line) => line.spans[0].style?.fg ?? null);
    expect(colors).toEqual([null, null, null, 6, null, 1, 2]);
    expect(diffLines(diff)[1].spans[0].style?.bold).toBe(true);
  });
});
