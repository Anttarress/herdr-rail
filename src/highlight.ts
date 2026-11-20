// A small, dependency-free syntax highlighter for the preview: comments,
// strings, numbers and keywords. It knows nothing about grammar; that is
// enough to make a file easy to scan.

import path from "node:path";
import { Color, span, type Span, type Style } from "./tui/screen.ts";

export interface Language {
  lineComments: string[];
  blockComment?: [string, string];
  quotes: string[];
  keywords: Set<string>;
}

const STYLE = {
  comment: { fg: Color.gray, italic: true },
  string: { fg: Color.green },
  number: { fg: Color.yellow },
  keyword: { fg: Color.magenta },
} as const satisfies Record<string, Style>;

function words(list: string): Set<string> {
  return new Set(list.split(" "));
}

function cLike(keywords: string, quotes = ['"', "'"]): Language {
  return { lineComments: ["//"], blockComment: ["/*", "*/"], quotes, keywords: words(keywords) };
}

function hashLike(keywords: string, quotes = ['"', "'"]): Language {
  return { lineComments: ["#"], quotes, keywords: words(keywords) };
}

const JS = cLike(
  "async await break case catch class const continue default delete do else export extends false finally for from " +
    "function if import in instanceof interface let new null of return static super switch this throw true try type " +
    "typeof undefined var void while yield enum implements readonly as satisfies",
  ['"', "'", "`"],
);
const RUST = cLike(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move " +
    "mut pub ref return self Self static struct super trait true type unsafe use where while",
  ['"'],
);
const GO = cLike(
  "break case chan const continue default defer else fallthrough false for func go goto if import interface map " +
    "nil package range return select struct switch true type var",
  ['"', "'", "`"],
);
const C = cLike(
  "auto bool break case catch char class const continue default delete do double else enum extern false float for " +
    "if inline int long namespace new null nullptr private protected public return short signed sizeof static " +
    "struct switch template this throw true try typedef union unsigned using virtual void volatile while " +
    "final override package import interface extends implements var val fun let func guard",
);
const PYTHON = hashLike(
  "and as assert async await break class continue def del elif else except False finally for from global if import " +
    "in is lambda None nonlocal not or pass raise return True try while with yield",
);
const SHELL = hashLike(
  "if then else elif fi for while until do done case esac in function return local export readonly set unset exit",
);
const CONFIG = hashLike("true false null yes no on off");
const RUBY = hashLike(
  "alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo " +
    "rescue retry return self super then true undef unless until when while yield require",
);
const SQL: Language = {
  lineComments: ["--"],
  blockComment: ["/*", "*/"],
  quotes: ["'", '"'],
  keywords: words(
    "select from where insert into values update set delete create table alter drop index join left right inner " +
      "outer on as and or not null primary key foreign references group by order having limit offset union " +
      "distinct case when then else end begin commit rollback",
  ),
};
const JSON_LANG: Language = { lineComments: [], quotes: ['"'], keywords: words("true false null") };
const CSS: Language = { lineComments: [], blockComment: ["/*", "*/"], quotes: ['"', "'"], keywords: new Set() };
const LUA: Language = {
  lineComments: ["--"],
  quotes: ['"', "'"],
  keywords: words("and break do else elseif end false for function if in local nil not or repeat return then true until while"),
};

const BY_EXTENSION: Record<string, Language> = {
  ts: JS, tsx: JS, js: JS, jsx: JS, mjs: JS, cjs: JS, mts: JS, cts: JS,
  rs: RUST, go: GO,
  c: C, h: C, cc: C, cpp: C, hpp: C, java: C, kt: C, swift: C, cs: C, scala: C, dart: C, php: C, zig: C,
  py: PYTHON, rb: RUBY, lua: LUA, sql: SQL,
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL,
  toml: CONFIG, yaml: CONFIG, yml: CONFIG, ini: CONFIG, conf: CONFIG, env: CONFIG,
  json: JSON_LANG, jsonc: JS, css: CSS, scss: cLike(""), less: cLike(""),
};

const BY_NAME: Record<string, Language> = {
  dockerfile: SHELL, makefile: SHELL, justfile: SHELL, gemfile: RUBY, rakefile: RUBY,
  ".gitignore": CONFIG, ".env": CONFIG, ".zshrc": SHELL, ".bashrc": SHELL, ".profile": SHELL,
};

export function languageFor(file: string): Language | null {
  const name = path.basename(file).toLowerCase();
  return BY_NAME[name] ?? BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1)] ?? null;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

/**
 * Highlight one line. `inBlock` says whether the line starts inside a block
 * comment; the returned flag carries that to the next line.
 */
export function highlightLine(text: string, lang: Language, inBlock: boolean): { spans: Span[]; inBlock: boolean } {
  const spans: Span[] = [];
  let plain = "";
  const flush = () => {
    if (plain) spans.push(span(plain));
    plain = "";
  };
  const push = (value: string, style: Style) => {
    flush();
    spans.push(span(value, style));
  };

  let i = 0;
  while (i < text.length) {
    if (inBlock && lang.blockComment) {
      const end = text.indexOf(lang.blockComment[1], i);
      const stop = end < 0 ? text.length : end + lang.blockComment[1].length;
      push(text.slice(i, stop), STYLE.comment);
      inBlock = end < 0;
      i = stop;
      continue;
    }
    if (lang.blockComment && text.startsWith(lang.blockComment[0], i)) {
      // Emit the opener here so `/*/` is not read as open-and-close.
      push(lang.blockComment[0], STYLE.comment);
      i += lang.blockComment[0].length;
      inBlock = true;
      continue;
    }
    if (lang.lineComments.some((marker) => text.startsWith(marker, i))) {
      push(text.slice(i), STYLE.comment);
      break;
    }
    const char = text[i];
    if (lang.quotes.includes(char)) {
      let end = i + 1;
      while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1;
      end = Math.min(text.length, end + 1);
      push(text.slice(i, end), STYLE.string);
      i = end;
    } else if (/\d/.test(char)) {
      let end = i + 1;
      while (end < text.length && /[\w.]/.test(text[end])) end += 1;
      push(text.slice(i, end), STYLE.number);
      i = end;
    } else if (IDENT_START.test(char)) {
      let end = i + 1;
      while (end < text.length && IDENT_PART.test(text[end])) end += 1;
      const word = text.slice(i, end);
      if (lang.keywords.has(word)) push(word, STYLE.keyword);
      else plain += word;
      i = end;
    } else {
      plain += char;
      i += 1;
    }
  }
  flush();
  return { spans, inBlock };
}
