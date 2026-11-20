// Opening, finding and closing the sidebar pane.
//
// herdr can only split a pane to the right or downwards, and a plugin pane
// always opens at half the split. Docking left is therefore: split the pane at
// the tab's left edge, swap the two, then set the split to the wanted width.
//
// `pane.swap` and `pane.focus` both switch the screen to the pane's tab
// (herdr 0.9.5). So the sidebar only ever opens in the tab on screen; a
// background tab gets its sidebar when the user next looks at it.

import path from "node:path";
import {
  call,
  comparePaneIds,
  PLUGIN_ID,
  snapshot as takeSnapshot,
  type Layout,
  type LayoutNode,
  type LayoutPane,
  type PaneInfo,
  type Snapshot,
} from "./herdr.ts";
import { isRailPane, TOKEN_SIDEBAR } from "./naming.ts";
import { loadSettings, readJson, sessionDir, withLock, writeJson, type Settings } from "./settings.ts";

/** herdr clamps every split ratio to this range. */
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

/** How long an identity token outlives its last heartbeat. */
export const TOKEN_TTL_MS = 30_000;

export function findSidebar(snap: Snapshot, tabId: string): PaneInfo | undefined {
  return snap.panes.find((pane) => pane.tab_id === tabId && TOKEN_SIDEBAR in (pane.tokens ?? {}));
}

/**
 * The pane to dock against: the tallest one touching the wanted edge, so the
 * sidebar is as close to full height as the layout allows.
 */
export function dockTarget(layout: Layout, side: "left" | "right", skip: Set<string>): LayoutPane | undefined {
  const edge = (pane: LayoutPane) => (side === "left" ? pane.rect.x : -(pane.rect.x + pane.rect.width));
  return layout.panes
    .filter((pane) => !skip.has(pane.pane_id))
    .sort(
      (a, b) =>
        edge(a) - edge(b) ||
        b.rect.height - a.rect.height ||
        a.rect.y - b.rect.y ||
        comparePaneIds(a.pane_id, b.pane_id),
    )[0];
}

/** Path (false = first child, true = second) to the split whose children are exactly panes `a` and `b`. */
export function splitPath(node: LayoutNode, a: string, b: string, trail: boolean[] = []): boolean[] | null {
  if (node.type !== "split") return null;
  const { first, second } = node;
  if (first.type === "pane" && second.type === "pane") {
    const ids = [first.pane_id, second.pane_id];
    return ids.includes(a) && ids.includes(b) ? trail : null;
  }
  return splitPath(first, a, b, [...trail, false]) ?? splitPath(second, a, b, [...trail, true]);
}

/** Share of the split the first child gets so the sidebar is `width` columns wide. */
export function sidebarRatio(width: number, splitWidth: number, side: "left" | "right"): number {
  const share = Math.min(MAX_RATIO, Math.max(MIN_RATIO, width / Math.max(1, splitWidth)));
  return side === "left" ? share : 1 - share;
}

export async function stampSidebar(paneId: string): Promise<void> {
  await call("pane.report_metadata", {
    pane_id: paneId,
    source: PLUGIN_ID,
    tokens: { [TOKEN_SIDEBAR]: "1" },
    ttl_ms: TOKEN_TTL_MS,
  });
}

function hiddenFile(): string {
  return path.join(sessionDir(), "hidden-tabs.json");
}

/** Tabs whose sidebar the user closed; auto-open leaves them alone. */
export function setHidden(tabId: string, hidden: boolean): void {
  const tabs = new Set(readJson<string[]>(hiddenFile(), []));
  if (hidden === tabs.has(tabId)) return;
  if (hidden) tabs.add(tabId);
  else tabs.delete(tabId);
  writeJson(hiddenFile(), [...tabs].slice(-200));
}

/** Also forgets tabs that have closed, so a reused tab id does not inherit the mark. */
function isHidden(tabId: string, liveTabs: Set<string>): boolean {
  const marked = readJson<string[]>(hiddenFile(), []);
  const live = marked.filter((id) => liveTabs.has(id));
  if (live.length !== marked.length) writeJson(hiddenFile(), live);
  return live.includes(tabId);
}

/** Dock a sidebar into the tab on screen. Returns its pane id, or null when there is nothing to dock against. */
async function openSidebar(snap: Snapshot, tabId: string, settings: Settings, focus: boolean): Promise<string | null> {
  const layout = snap.layouts.find((entry) => entry.tab_id === tabId);
  if (!layout) return null;
  const rail = new Set(snap.panes.filter(isRailPane).map((pane) => pane.pane_id));
  const target = dockTarget(layout, settings.dock, rail);
  if (!target) return null;
  const neighbour = snap.panes.find((pane) => pane.pane_id === target.pane_id);
  const cwd = neighbour?.foreground_cwd ?? neighbour?.cwd;

  // No `cwd` param: herdr resolves the manifest's relative command against
  // it. The folder to show travels in the environment instead.
  const opened = await call<{ plugin_pane: { pane: PaneInfo } }>("plugin.pane.open", {
    plugin_id: PLUGIN_ID,
    entrypoint: "sidebar",
    placement: "split",
    target_pane_id: target.pane_id,
    direction: "right",
    focus: false,
    env: cwd ? { RAIL_CWD: cwd } : {},
  });
  const paneId = opened.plugin_pane.pane.pane_id;
  // Stamp before touching the layout: the swap and focus below emit events,
  // and a hook they trigger must already recognise this pane as the sidebar.
  await stampSidebar(paneId);

  if (settings.dock === "left") {
    await call("pane.swap", { source_pane_id: paneId, target_pane_id: target.pane_id });
  }
  const exported = await call<{ layout: { root: LayoutNode } }>("layout.export", { tab_id: tabId });
  const trail = splitPath(exported.layout.root, paneId, target.pane_id);
  if (trail) {
    await call("layout.set_split_ratio", {
      tab_id: tabId,
      path: trail,
      ratio: sidebarRatio(settings.width, target.rect.width, settings.dock),
    });
  }
  if (focus) {
    await call("pane.focus", { pane_id: paneId });
  } else if ((await takeSnapshot()).focused_pane_id === paneId) {
    // The swap focused the sidebar; give focus back. Checked against live
    // focus so a user who has already moved on is not pulled back.
    await call("pane.focus", { pane_id: layout.focused_pane_id }).catch(() => undefined);
  }
  return paneId;
}

function contextTab(snap: Snapshot): string | undefined {
  const fromEnv = process.env.HERDR_TAB_ID;
  if (fromEnv && snap.tabs.some((tab) => tab.tab_id === fromEnv)) return fromEnv;
  return snap.focused_tab_id ?? undefined;
}

/** Open and focus the sidebar; focus it if it is open; close it if it has focus. */
export async function toggleSidebar(): Promise<string> {
  const outcome = await withLock("dock", 4000, async () => {
    const snap = await takeSnapshot();
    const tabId = contextTab(snap);
    if (!tabId) return "no focused tab";
    if (snap.focused_tab_id !== tabId) return `${tabId} is not on screen`;
    const existing = findSidebar(snap, tabId);
    if (!existing) {
      setHidden(tabId, false);
      const paneId = await openSidebar(snap, tabId, loadSettings(), true);
      return paneId ? `opened ${paneId}` : "nothing to dock against";
    }
    if (snap.focused_pane_id === existing.pane_id) {
      setHidden(tabId, true);
      await call("pane.close", { pane_id: existing.pane_id });
      return `closed ${existing.pane_id}`;
    }
    await call("pane.focus", { pane_id: existing.pane_id });
    return `focused ${existing.pane_id}`;
  });
  return outcome ?? "busy";
}

/** Auto-open: give the tab a sidebar unless it has one or the user closed it there. */
export async function ensureSidebar(settings: Settings): Promise<string> {
  // Focus events arrive in bursts and hooks run concurrently; a busy lock
  // means another hook is already docking.
  const outcome = await withLock("dock", 0, async () => {
    const snap = await takeSnapshot();
    const tabId = contextTab(snap);
    if (!tabId || snap.focused_tab_id !== tabId) return "tab is not on screen";
    const liveTabs = new Set(snap.tabs.map((tab) => tab.tab_id));
    if (isHidden(tabId, liveTabs) || findSidebar(snap, tabId)) return "nothing to do";
    const panes = snap.panes.filter((pane) => pane.tab_id === tabId);
    if (panes.length === 0 || panes.every(isRailPane)) return "nothing to do";
    const paneId = await openSidebar(snap, tabId, settings, false);
    return paneId ? `opened ${paneId}` : "nothing to dock against";
  });
  return outcome ?? "busy";
}
