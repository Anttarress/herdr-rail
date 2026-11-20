import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dockTarget, findSidebar, sidebarRatio, splitPath } from "../src/dock.ts";
import type { Layout, LayoutNode, Snapshot } from "../src/herdr.ts";
import { sanitize, DEFAULTS } from "../src/settings.ts";
import { VERSION } from "../src/version.ts";

function layout(panes: [string, number, number, number, number][]): Layout {
  return {
    workspace_id: "w1",
    tab_id: "w1:t1",
    zoomed: false,
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: panes[0][0],
    panes: panes.map(([pane_id, x, y, width, height]) => ({ pane_id, focused: false, rect: { x, y, width, height } })),
  };
}

const pane = (pane_id: string): LayoutNode => ({ type: "pane", pane_id });
const split = (first: LayoutNode, second: LayoutNode): LayoutNode => ({
  type: "split",
  direction: "right",
  ratio: 0.5,
  first,
  second,
});

describe("dockTarget", () => {
  // Left column split in two, one full-height pane on the right.
  const three = layout([
    ["w1:p1", 0, 0, 60, 20],
    ["w1:p3", 0, 20, 60, 20],
    ["w1:p2", 60, 0, 60, 40],
  ]);

  test("a lone pane is the target on either side", () => {
    const one = layout([["w1:p1", 0, 0, 120, 40]]);
    expect(dockTarget(one, "left", new Set())?.pane_id).toBe("w1:p1");
    expect(dockTarget(one, "right", new Set())?.pane_id).toBe("w1:p1");
  });

  test("picks the pane on the wanted edge", () => {
    expect(dockTarget(three, "right", new Set())?.pane_id).toBe("w1:p2");
    expect(dockTarget(three, "left", new Set())?.pane_id).toBe("w1:p1");
  });

  test("prefers the tallest pane on that edge", () => {
    const uneven = layout([
      ["w1:p1", 0, 0, 60, 10],
      ["w1:p3", 0, 10, 60, 30],
      ["w1:p2", 60, 0, 60, 40],
    ]);
    expect(dockTarget(uneven, "left", new Set())?.pane_id).toBe("w1:p3");
  });

  test("never docks against a pane of its own", () => {
    expect(dockTarget(three, "right", new Set(["w1:p2"]))?.pane_id).toBe("w1:p1");
    expect(dockTarget(three, "left", new Set(["w1:p1", "w1:p2", "w1:p3"]))).toBeUndefined();
  });
});

describe("splitPath", () => {
  test("the root split has an empty path", () => {
    expect(splitPath(split(pane("a"), pane("b")), "b", "a")).toEqual([]);
  });

  test("walks to a nested split", () => {
    const tree = split(split(pane("side"), pane("a")), split(pane("b"), split(pane("c"), pane("d"))));
    expect(splitPath(tree, "side", "a")).toEqual([false]);
    expect(splitPath(tree, "d", "c")).toEqual([true, true]);
  });

  test("is null when the two panes are not siblings", () => {
    const tree = split(split(pane("side"), pane("a")), pane("b"));
    expect(splitPath(tree, "side", "b")).toBeNull();
    expect(splitPath(pane("a"), "a", "b")).toBeNull();
  });
});

describe("sidebarRatio", () => {
  test("is the first child's share of the split", () => {
    expect(sidebarRatio(30, 120, "left")).toBeCloseTo(0.25);
    expect(sidebarRatio(30, 120, "right")).toBeCloseTo(0.75);
  });

  test("stays inside herdr's limits", () => {
    expect(sidebarRatio(4, 200, "left")).toBeCloseTo(0.1);
    expect(sidebarRatio(500, 100, "left")).toBeCloseTo(0.9);
    expect(sidebarRatio(4, 200, "right")).toBeCloseTo(0.9);
  });
});

test("findSidebar looks only in the given tab", () => {
  const snap = {
    layouts: [],
    tabs: [],
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: true, agent_status: "idle" },
      { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", focused: false, agent_status: "unknown", tokens: { "rail-sidebar": "1" } },
    ],
  } satisfies Snapshot;
  expect(findSidebar(snap, "w1:t1")).toBeUndefined();
  expect(findSidebar(snap, "w1:t2")?.pane_id).toBe("w1:p2");
});

describe("settings", () => {
  test("bad values fall back to defaults", () => {
    expect(sanitize(null)).toEqual(DEFAULTS);
    expect(sanitize({ autoName: "yes", dock: "top", width: "wide" })).toEqual(DEFAULTS);
  });

  test("good values are kept and numbers clamped", () => {
    const settings = sanitize({ autoName: false, dock: "right", width: 500, nameMaxLength: 2, unknown: 1 });
    expect(settings).toEqual({ ...DEFAULTS, autoName: false, dock: "right", width: 80, nameMaxLength: 8 });
  });
});

describe("herdr-plugin.toml", () => {
  const root = path.join(import.meta.dir, "..");
  const manifest = fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8");

  test("agrees with package.json and the binary on the version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest).toContain(`version = "${VERSION}"`);
    expect(pkg.version).toBe(VERSION);
  });

  test("hooks only events herdr 0.9 accepts", () => {
    // PLUGIN_HOOK_EVENT_KINDS in herdr's src/api/schema/events.rs.
    const hookable = new Set([
      "workspace.created", "workspace.updated", "workspace.closed", "workspace.renamed", "workspace.moved",
      "workspace.reordered", "workspace.focused", "worktree.created", "worktree.opened", "worktree.removed",
      "tab.created", "tab.closed", "tab.renamed", "tab.moved", "tab.focused", "pane.created", "pane.closed",
      "pane.focused", "pane.moved", "pane.exited", "pane.agent_detected", "pane.agent_status_changed",
    ]);
    const events = [...manifest.matchAll(/^on = "([^"]+)"$/gm)].map((match) => match[1]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((event) => !hookable.has(event))).toEqual([]);
    expect(new Set(events).size).toBe(events.length);
  });

  test("names its panes so the tab namer can recognise them", () => {
    const titles = [...manifest.matchAll(/^title = "([^"]+)"\nplacement/gm)].map((match) => match[1]);
    expect(titles).toEqual(["Rail", "Rail Preview"]);
  });
});
