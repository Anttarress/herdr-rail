// Pure rules for automatic tab names. A tab is named after, in order:
//   1. the task title an agent in it reports (Claude Code and friends set the
//      terminal title to a summary of what they are working on),
//   2. the command running in its focused pane (`npm run dev`),
//   3. the folder that pane is in.

import os from "node:os";
import path from "node:path";
import { comparePaneIds, type PaneInfo, type ProcessInfo } from "./herdr.ts";

export const TOKEN_SIDEBAR = "rail-sidebar";
export const TOKEN_PREVIEW = "rail-preview";
/** Pane titles in herdr-plugin.toml start with this; herdr applies them as the pane label. */
export const PANE_LABEL_PREFIX = "Rail";

const SHELLS = new Set([
  "zsh", "bash", "fish", "sh", "dash", "ksh", "csh", "tcsh", "nu", "elvish", "xonsh", "pwsh", "powershell", "login",
]);

/** Titles an agent shows before it has a task; they say nothing about the tab. */
const GENERIC_TITLES = new Set([
  "claude", "claude code", "codex", "codex cli", "gemini", "gemini cli", "opencode", "amp", "aider", "cursor",
  "cursor agent", "copilot", "droid", "goose", "pi", "hermes", "qwen", "kiro", "terminal", "new session",
]);

export interface NameOptions {
  maxLength: number;
  fromProcess: boolean;
  home?: string;
}

/** The sidebar and preview panes never name a tab. */
export function isRailPane(pane: PaneInfo): boolean {
  const tokens = pane.tokens ?? {};
  return TOKEN_SIDEBAR in tokens || TOKEN_PREVIEW in tokens || (pane.label ?? "").startsWith(PANE_LABEL_PREFIX);
}

/** herdr labels an unnamed tab with its number; an emptied label counts too. */
export function isDefaultLabel(label: string): boolean {
  return /^\d*$/.test(label.trim());
}

function clean(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikePrompt(title: string): boolean {
  // `user@host:~/dir`, an absolute or home-relative path, or a bare shell name.
  return /^[\w.-]+@[\w.-]+:/.test(title) || /^(~|\/|[A-Za-z]:\\)/.test(title) || SHELLS.has(title.toLowerCase());
}

/** The task an agent pane reports, or null when its title is only boilerplate. */
export function agentTitle(pane: PaneInfo): string | null {
  for (const raw of [pane.terminal_title_stripped, pane.terminal_title, pane.title]) {
    // Agents prefix a status glyph (✳, ⠂, ●); drop it and any other leading
    // symbols, but keep what starts a path so a prompt is still recognised.
    const title = clean(raw ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "");
    if (!title) continue;
    const lower = title.toLowerCase();
    if (GENERIC_TITLES.has(lower) || lower === (pane.agent ?? "").toLowerCase() || looksLikePrompt(title)) continue;
    return title;
  }
  return null;
}

function programName(value: string | undefined): string {
  // A login shell reports itself as `-zsh`.
  return path.basename((value ?? "").replace(/^-/, ""));
}

/** `npm run dev`, `vim app.ts`: the foreground command, or null at a shell prompt. */
export function processLabel(info: ProcessInfo | undefined): string | null {
  const running = (info?.foreground_processes ?? []).filter(
    (proc) => proc.pid !== info?.shell_pid && !SHELLS.has(programName(proc.argv0 ?? proc.name).toLowerCase()),
  );
  if (running.length === 0) return null;
  // The lowest pid in the foreground group is the command the user typed.
  const proc = running.reduce((first, next) => (next.pid < first.pid ? next : first));
  const argv = proc.argv?.length ? proc.argv : (proc.cmdline ?? proc.name ?? "").split(/\s+/);
  const words = [programName(argv[0] || proc.name)];
  for (const arg of argv.slice(1)) {
    // Stop at the first flag: what follows may be its value, not a subcommand.
    if (words.length >= 3 || arg.startsWith("-")) break;
    words.push(arg.includes("/") ? path.basename(arg) : arg);
  }
  return clean(words.join(" ")) || null;
}

export function folderLabel(cwd: string | null | undefined, home = os.homedir()): string | null {
  if (!cwd) return null;
  if (cwd === home) return "~";
  return path.basename(cwd) || "/";
}

/** Shorten to `maxLength` characters, ending on a whole word when one ends near the limit. */
export function truncateLabel(label: string, maxLength: number): string {
  const chars = [...label];
  if (chars.length <= maxLength) return label;
  const cut = chars.slice(0, maxLength - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  const midWord = chars[maxLength - 1] !== " " && lastSpace >= maxLength * 0.6;
  return `${(midWord ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function ownPanes(panes: PaneInfo[]): PaneInfo[] {
  return panes.filter((pane) => !isRailPane(pane)).sort((a, b) => comparePaneIds(a.pane_id, b.pane_id));
}

/** The pane whose folder and command describe the tab: its focused pane, else its first. */
export function primaryPane(panes: PaneInfo[], focusedPaneId?: string): PaneInfo | undefined {
  const own = ownPanes(panes);
  return own.find((pane) => pane.pane_id === focusedPaneId) ?? own[0];
}

function titledAgent(panes: PaneInfo[], focusedPaneId?: string): string | null {
  const agents = ownPanes(panes).filter((pane) => pane.agent);
  const busy = (pane: PaneInfo) => pane.agent_status === "working" || pane.agent_status === "blocked";
  const ordered = [
    ...agents.filter((pane) => pane.pane_id === focusedPaneId),
    ...agents.filter(busy),
    ...agents,
  ];
  for (const pane of ordered) {
    const title = agentTitle(pane);
    if (title) return title;
  }
  return null;
}

/** The pane whose foreground command is needed to name the tab, if any. */
export function paneNeedingProcess(panes: PaneInfo[], focusedPaneId: string | undefined): string | null {
  if (titledAgent(panes, focusedPaneId)) return null;
  const primary = primaryPane(panes, focusedPaneId);
  return primary && !primary.agent ? primary.pane_id : null;
}

/** The label for a tab holding `panes`, or null when it has nothing of its own to name. */
export function computeLabel(
  panes: PaneInfo[],
  focusedPaneId: string | undefined,
  processes: Map<string, ProcessInfo>,
  options: NameOptions,
): string | null {
  const primary = primaryPane(panes, focusedPaneId);
  if (!primary) return null;
  const label =
    titledAgent(panes, focusedPaneId) ??
    (options.fromProcess && !primary.agent ? processLabel(processes.get(primary.pane_id)) : null) ??
    folderLabel(primary.foreground_cwd ?? primary.cwd, options.home);
  return label ? truncateLabel(label, options.maxLength) : null;
}

export interface NamingState {
  /** The label last written to each tab. */
  labels: Record<string, string>;
  /** Labels written recently; tab ids shift when herdr restarts, labels do not. */
  recent: string[];
}

export const EMPTY_STATE: NamingState = { labels: {}, recent: [] };

/**
 * A tab is ours to rename while it still carries a default label or one we
 * wrote. Any other label was typed by the user and is left alone.
 */
export function isManaged(tabId: string, label: string, state: NamingState): boolean {
  return isDefaultLabel(label) || state.labels[tabId] === label || state.recent.includes(label);
}
