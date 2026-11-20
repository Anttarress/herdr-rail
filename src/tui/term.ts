// Raw-mode terminal session: alternate screen, mouse reporting, bracketed
// paste, and a guaranteed restore on every way out.

import { parseInput, type InputEvent } from "./keys.ts";

const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h";
const LEAVE = "\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l";

export interface Terminal {
  columns(): number;
  rows(): number;
  write(data: string): void;
  close(): void;
}

export interface TerminalHandlers {
  input(event: InputEvent): void;
  resize(): void;
}

export function openTerminal(handlers: TerminalHandlers, title: string): Terminal {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("this view needs a terminal; open it through herdr (see README)");
  }
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    stdout.write(LEAVE);
    stdin.setRawMode(false);
    stdin.pause();
  };

  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  stdout.write(`${ENTER}\x1b]2;${title}\x07`);
  stdin.on("data", (data: string) => {
    for (const event of parseInput(data)) handlers.input(event);
  });
  stdout.on("resize", handlers.resize);
  process.on("SIGWINCH", handlers.resize);
  process.on("exit", close);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      close();
      process.exit(0);
    });
  }

  return {
    columns: () => stdout.columns || 80,
    rows: () => stdout.rows || 24,
    write: (data) => {
      if (open) stdout.write(data);
    },
    close,
  };
}
