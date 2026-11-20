// Settings (user-editable, in herdr's plugin config dir) and small JSON state
// files (in the plugin state dir). herdr passes both directories to every
// action, hook and pane; the fallbacks mirror herdr's own paths for runs
// started by hand.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ID, socketPath } from "./herdr.ts";

export interface Settings {
  /** Rename tabs from what runs in them. */
  autoName: boolean;
  nameMaxLength: number;
  /** Use a running command (`npm run dev`) when no agent names the tab. */
  nameFromProcess: boolean;
  dock: "left" | "right";
  /** Preferred sidebar width in columns. */
  width: number;
  /** Dock a sidebar into every tab as it gets focus. */
  autoOpen: boolean;
  followCwd: boolean;
  showHidden: boolean;
}

export const DEFAULTS: Settings = {
  autoName: true,
  nameMaxLength: 28,
  nameFromProcess: true,
  dock: "left",
  width: 34,
  autoOpen: false,
  followCwd: true,
  showHidden: true,
};

export const LIMITS = {
  nameMaxLength: { min: 8, max: 60 },
  width: { min: 20, max: 80 },
} as const;

export function configDir(): string {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "herdr", "plugins", "config", PLUGIN_ID);
}

export function stateDir(): string {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "herdr", "plugins", PLUGIN_ID);
}

/**
 * State about tabs and panes is kept per herdr session: ids such as `w1:t1`
 * repeat across sessions, and all sessions share one plugin state dir.
 */
export function sessionDir(): string {
  const key = createHash("sha1").update(socketPath()).digest("hex").slice(0, 12);
  return path.join(stateDir(), "sessions", key);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write through a temp file so a concurrent reader never sees half a file. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** Keep only well-typed values; anything else falls back to the default. */
export function sanitize(raw: unknown): Settings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const settings: Settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (typeof source[key] === typeof DEFAULTS[key]) {
      (settings as unknown as Record<string, unknown>)[key] = source[key];
    }
  }
  if (settings.dock !== "left" && settings.dock !== "right") settings.dock = DEFAULTS.dock;
  settings.nameMaxLength = clamp(settings.nameMaxLength, LIMITS.nameMaxLength);
  settings.width = clamp(settings.width, LIMITS.width);
  return settings;
}

export function settingsFile(): string {
  return path.join(configDir(), "settings.json");
}

export function loadSettings(): Settings {
  return sanitize(readJson<unknown>(settingsFile(), {}));
}

export function saveSettings(settings: Settings): void {
  writeJson(settingsFile(), sanitize(settings));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding an exclusive lock file. Returns undefined when the
 * lock stays busy for `waitMs`. A lock older than 15s belongs to a process
 * that died and is taken over.
 */
export async function withLock<T>(name: string, waitMs: number, fn: () => Promise<T>): Promise<T | undefined> {
  const file = path.join(sessionDir(), `${name}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(file).mtimeMs > 15_000;
      } catch {
        continue; // released between the open and the stat
      }
      if (stale) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(40);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}
