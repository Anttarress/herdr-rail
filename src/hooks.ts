// Entry point for every `[[events]]` hook in herdr-plugin.toml.

import fs from "node:fs";
import path from "node:path";
import { ensureSidebar } from "./dock.ts";
import { nameTabs } from "./namer.ts";
import { loadSettings, sessionDir, sleep } from "./settings.ts";

const OPEN_EVENTS = new Set(["tab.created", "tab.focused", "workspace.created", "workspace.focused", "pane.focused"]);

/**
 * An agent sets its title a few seconds into a task, and herdr has no hook
 * for title changes. After an agent event, look again at these delays.
 */
const AGENT_EVENTS = new Set(["pane.agent_status_changed", "pane.agent_detected"]);
const RECHECK_DELAYS_MS = [3000, 6000];

function recheckFile(): string {
  return path.join(sessionDir(), "recheck");
}

export async function runHook(): Promise<void> {
  const settings = loadSettings();
  const event = process.env.HERDR_PLUGIN_EVENT ?? "";
  if (settings.autoOpen && OPEN_EVENTS.has(event)) {
    await ensureSidebar(settings).catch((error) => console.error(`auto-open: ${error.message}`));
  }
  if (!settings.autoName) return;
  await nameTabs({ settings });
  if (!AGENT_EVENTS.has(event)) return;

  // Only the newest agent hook keeps rechecking; older ones stand down.
  const ticket = `${process.pid}-${Date.now()}`;
  fs.mkdirSync(sessionDir(), { recursive: true });
  fs.writeFileSync(recheckFile(), ticket);
  for (const delay of RECHECK_DELAYS_MS) {
    await sleep(delay);
    if (fs.readFileSync(recheckFile(), "utf8") !== ticket) return;
    const current = loadSettings();
    if (!current.autoName) return;
    await nameTabs({ settings: current });
  }
}
