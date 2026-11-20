// Applies the naming rules to the live session.

import path from "node:path";
import { call, snapshot as takeSnapshot, type ProcessInfo, type Snapshot } from "./herdr.ts";
import {
  computeLabel,
  EMPTY_STATE,
  isManaged,
  paneNeedingProcess,
  type NamingState,
} from "./naming.ts";
import { loadSettings, readJson, sessionDir, writeJson, type Settings } from "./settings.ts";

const RECENT_LIMIT = 200;

export interface Rename {
  tab_id: string;
  from: string;
  to: string;
}

export interface NameTabsOptions {
  settings?: Settings;
  snapshot?: Snapshot;
  /** Report what would change without renaming anything. */
  dryRun?: boolean;
  /** Treat this tab as ours even if the user renamed it. */
  adopt?: string;
}

function stateFile(): string {
  return path.join(sessionDir(), "naming.json");
}

export function loadNamingState(): NamingState {
  const raw = readJson<Partial<NamingState>>(stateFile(), {});
  return {
    labels: raw.labels && typeof raw.labels === "object" ? raw.labels : { ...EMPTY_STATE.labels },
    recent: Array.isArray(raw.recent) ? raw.recent.filter((label) => typeof label === "string") : [],
  };
}

/**
 * Merge our writes into whatever is on disk now. Hooks run concurrently, so
 * the file is re-read here instead of saving the copy read at the start.
 */
function recordLabels(written: Map<string, string>, liveTabs: Set<string>): void {
  const state = loadNamingState();
  let changed = false;
  for (const [tabId, label] of written) {
    if (state.labels[tabId] !== label) {
      state.labels[tabId] = label;
      changed = true;
    }
    if (!state.recent.includes(label)) {
      state.recent = [...state.recent, label].slice(-RECENT_LIMIT);
      changed = true;
    }
  }
  for (const tabId of Object.keys(state.labels)) {
    if (!liveTabs.has(tabId)) {
      delete state.labels[tabId];
      changed = true;
    }
  }
  if (changed) writeJson(stateFile(), state);
}

async function processInfo(paneId: string): Promise<ProcessInfo | undefined> {
  try {
    return (await call<{ process_info: ProcessInfo }>("pane.process_info", { pane_id: paneId })).process_info;
  } catch {
    return undefined; // the pane closed, or the platform cannot report processes
  }
}

/** Rename every tab we manage whose computed name differs from its label. */
export async function nameTabs(options: NameTabsOptions = {}): Promise<Rename[]> {
  const settings = options.settings ?? loadSettings();
  const snap = options.snapshot ?? (await takeSnapshot());
  const state = loadNamingState();
  const renames: Rename[] = [];
  const owned = new Map<string, string>();

  for (const tab of snap.tabs) {
    if (tab.tab_id !== options.adopt && !isManaged(tab.tab_id, tab.label, state)) continue;
    const panes = snap.panes.filter((pane) => pane.tab_id === tab.tab_id);
    const focused = snap.layouts.find((layout) => layout.tab_id === tab.tab_id)?.focused_pane_id;
    const processes = new Map<string, ProcessInfo>();
    const wanted = settings.nameFromProcess ? paneNeedingProcess(panes, focused) : null;
    if (wanted) {
      const info = await processInfo(wanted);
      if (info) processes.set(wanted, info);
    }
    const label = computeLabel(panes, focused, processes, {
      maxLength: settings.nameMaxLength,
      fromProcess: settings.nameFromProcess,
    });
    if (!label) continue;
    owned.set(tab.tab_id, label);
    if (label !== tab.label) renames.push({ tab_id: tab.tab_id, from: tab.label, to: label });
  }

  if (options.dryRun) return renames;
  // Record before renaming: a concurrent hook that sees the new label must
  // already find it in the state, or it would take the tab for a manual one.
  recordLabels(owned, new Set(snap.tabs.map((tab) => tab.tab_id)));
  const applied: Rename[] = [];
  for (const rename of renames) {
    try {
      await call("tab.rename", { tab_id: rename.tab_id, label: rename.to });
      applied.push(rename);
    } catch {
      // The tab closed since the snapshot.
    }
  }
  return applied;
}
