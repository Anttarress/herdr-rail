// Client for herdr's socket API: newline-delimited JSON, one request per
// connection. Shapes follow `herdr api schema --json` (protocol 22).

import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = "herdr-rail";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused: boolean;
  agent?: string | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  tokens?: Record<string, string>;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
}

export interface LayoutPane {
  pane_id: string;
  focused: boolean;
  rect: Rect;
}

export interface Layout {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: Rect;
  focused_pane_id: string;
  panes: LayoutPane[];
}

export interface Snapshot {
  focused_pane_id?: string | null;
  focused_tab_id?: string | null;
  focused_workspace_id?: string | null;
  layouts: Layout[];
  panes: PaneInfo[];
  tabs: TabInfo[];
}

export interface ProcessEntry {
  pid: number;
  name?: string;
  argv0?: string;
  argv?: string[];
  cmdline?: string;
}

export interface ProcessInfo {
  pane_id: string;
  shell_pid?: number | null;
  foreground_processes?: ProcessEntry[];
}

export type LayoutNode =
  | { type: "pane"; pane_id: string }
  | { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };

export class HerdrError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function socketPath(): string {
  return process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

export function call<T = unknown>(method: string, params: object = {}, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath() });
    let buffer = "";
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      finish();
    };
    const timer = setTimeout(
      () => settle(() => reject(new HerdrError("timeout", `herdr did not answer ${method}`))),
      timeoutMs,
    );
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ id: `${PLUGIN_ID}:${method}`, method, params })}\n`);
    });
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      settle(() => {
        try {
          const message = JSON.parse(buffer.slice(0, end));
          if (message.error) {
            reject(new HerdrError(message.error.code ?? "error", message.error.message ?? `${method} failed`));
          } else {
            resolve(message.result as T);
          }
        } catch (error) {
          reject(error as Error);
        }
      });
    });
    sock.on("error", (error) => settle(() => reject(error)));
    sock.on("close", () => settle(() => reject(new HerdrError("closed", `herdr closed the connection during ${method}`))));
  });
}

export async function snapshot(): Promise<Snapshot> {
  return (await call<{ snapshot: Snapshot }>("session.snapshot")).snapshot;
}

/** A stable order for ids such as `w1:p2`, `w1:p10`, `w1:pA`; used wherever "the first pane" must be the same every time. */
export function comparePaneIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
