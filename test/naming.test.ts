import { describe, expect, test } from "bun:test";
import type { PaneInfo, ProcessInfo } from "../src/herdr.ts";
import {
  agentTitle,
  computeLabel,
  folderLabel,
  isDefaultLabel,
  isManaged,
  isRailPane,
  paneNeedingProcess,
  processLabel,
  truncateLabel,
  type NamingState,
} from "../src/naming.ts";

const options = { maxLength: 28, fromProcess: true, home: "/Users/dev" };

function pane(id: string, extra: Partial<PaneInfo> = {}): PaneInfo {
  return {
    pane_id: id,
    tab_id: "w1:t1",
    workspace_id: "w1",
    focused: false,
    agent_status: "unknown",
    cwd: "/Users/dev/code/shop",
    ...extra,
  };
}

function claude(id: string, title: string | null, extra: Partial<PaneInfo> = {}): PaneInfo {
  return pane(id, {
    agent: "claude",
    agent_status: "idle",
    terminal_title: title === null ? null : `✳ ${title}`,
    terminal_title_stripped: title,
    ...extra,
  });
}

function running(paneId: string, argv: string[], shellPid = 100): ProcessInfo {
  return {
    pane_id: paneId,
    shell_pid: shellPid,
    foreground_processes: [{ pid: shellPid + 50, name: argv[0], argv0: argv[0], argv }],
  };
}

describe("agentTitle", () => {
  test("uses the task an agent reports", () => {
    expect(agentTitle(claude("w1:p1", "Fix the login redirect"))).toBe("Fix the login redirect");
  });

  test("strips a status glyph herdr did not strip", () => {
    expect(agentTitle(pane("w1:p1", { agent: "claude", terminal_title: "⠂ Review PR 42" }))).toBe("Review PR 42");
  });

  test("ignores boilerplate titles", () => {
    expect(agentTitle(claude("w1:p1", "Claude Code"))).toBeNull();
    expect(agentTitle(pane("w1:p1", { agent: "codex", terminal_title_stripped: "codex" }))).toBeNull();
    expect(agentTitle(claude("w1:p1", null))).toBeNull();
  });

  test("ignores a shell prompt or path left in the title", () => {
    expect(agentTitle(claude("w1:p1", "dev@Mac:~/code/shop"))).toBeNull();
    expect(agentTitle(claude("w1:p1", "~/code/shop"))).toBeNull();
    expect(agentTitle(claude("w1:p1", "/Users/dev/code"))).toBeNull();
  });
});

describe("processLabel", () => {
  test("names the foreground command with its subcommands", () => {
    expect(processLabel(running("p", ["npm", "run", "dev"]))).toBe("npm run dev");
    expect(processLabel(running("p", ["lazygit"]))).toBe("lazygit");
  });

  test("stops at the first flag, whose value could be anything", () => {
    expect(processLabel(running("p", ["npm", "run", "dev", "--port", "3000"]))).toBe("npm run dev");
    expect(processLabel(running("p", ["ssh", "-p", "2222", "host"]))).toBe("ssh");
  });

  test("shortens paths to their file name", () => {
    expect(processLabel(running("p", ["/usr/bin/vim", "src/app/main.ts"]))).toBe("vim main.ts");
  });

  test("uses at most three words", () => {
    expect(processLabel(running("p", ["docker", "compose", "up", "web", "db"]))).toBe("docker compose up");
  });

  test("is null at a shell prompt", () => {
    const idle: ProcessInfo = {
      pane_id: "p",
      shell_pid: 100,
      foreground_processes: [{ pid: 100, name: "zsh", argv0: "zsh", argv: ["-zsh"] }],
    };
    expect(processLabel(idle)).toBeNull();
    expect(processLabel(undefined)).toBeNull();
    // A nested shell is still a shell.
    expect(processLabel(running("p", ["bash"]))).toBeNull();
  });

  test("picks the command the user typed, not its children", () => {
    const info: ProcessInfo = {
      pane_id: "p",
      shell_pid: 100,
      foreground_processes: [
        { pid: 230, name: "node", argv: ["node", "server.js"] },
        { pid: 200, name: "npm", argv: ["npm", "start"] },
      ],
    };
    expect(processLabel(info)).toBe("npm start");
  });
});

describe("folderLabel", () => {
  test("is the folder name, ~ for home and / for the root", () => {
    expect(folderLabel("/Users/dev/code/shop", "/Users/dev")).toBe("shop");
    expect(folderLabel("/Users/dev", "/Users/dev")).toBe("~");
    expect(folderLabel("/", "/Users/dev")).toBe("/");
    expect(folderLabel(null)).toBeNull();
  });
});

describe("computeLabel", () => {
  const none = new Map<string, ProcessInfo>();

  test("an agent's task names the tab", () => {
    const panes = [pane("w1:p1"), claude("w1:p2", "Add CSV export")];
    expect(computeLabel(panes, "w1:p1", none, options)).toBe("Add CSV export");
  });

  test("the focused agent wins, then a busy one", () => {
    const panes = [claude("w1:p1", "First task"), claude("w1:p2", "Second task", { agent_status: "working" })];
    expect(computeLabel(panes, "w1:p1", none, options)).toBe("First task");
    expect(computeLabel(panes, undefined, none, options)).toBe("Second task");
  });

  test("falls back to the running command, then the folder", () => {
    const panes = [pane("w1:p1")];
    const processes = new Map([["w1:p1", running("w1:p1", ["npm", "run", "dev"])]]);
    expect(computeLabel(panes, "w1:p1", processes, options)).toBe("npm run dev");
    expect(computeLabel(panes, "w1:p1", none, options)).toBe("shop");
    expect(computeLabel(panes, "w1:p1", processes, { ...options, fromProcess: false })).toBe("shop");
  });

  test("an agent without a task is named after its folder, never after its own process", () => {
    const panes = [claude("w1:p1", "Claude Code")];
    const processes = new Map([["w1:p1", running("w1:p1", ["claude", "--resume"])]]);
    expect(computeLabel(panes, "w1:p1", processes, options)).toBe("shop");
  });

  test("prefers the live working directory", () => {
    const panes = [pane("w1:p1", { cwd: "/Users/dev", foreground_cwd: "/Users/dev/code/api" })];
    expect(computeLabel(panes, "w1:p1", none, options)).toBe("api");
  });

  test("the sidebar and preview never name a tab", () => {
    const sidebar = pane("w1:p9", { tokens: { "rail-sidebar": "1" }, cwd: "/opt/plugins/herdr-rail" });
    const fresh = pane("w1:p8", { label: "Rail", cwd: "/opt/plugins/herdr-rail" });
    expect(isRailPane(sidebar)).toBe(true);
    expect(isRailPane(fresh)).toBe(true);
    // Focus on the sidebar leaves the tab named after its real pane.
    expect(computeLabel([sidebar, pane("w1:p1")], "w1:p9", none, options)).toBe("shop");
    expect(computeLabel([sidebar, fresh], "w1:p9", none, options)).toBeNull();
  });

  test("orders panes numerically when none is focused", () => {
    const panes = [pane("w1:p10", { cwd: "/tmp/ten" }), pane("w1:p2", { cwd: "/tmp/two" })];
    expect(computeLabel(panes, undefined, none, options)).toBe("two");
  });

  test("truncates long labels", () => {
    const panes = [claude("w1:p1", "Investigate why the nightly build fails on arm64 runners")];
    const label = computeLabel(panes, "w1:p1", none, { ...options, maxLength: 20 });
    expect(label).toBe("Investigate why the…");
    expect([...(label as string)].length).toBeLessThanOrEqual(20);
  });
});

describe("paneNeedingProcess", () => {
  test("asks only when a plain pane would name the tab", () => {
    expect(paneNeedingProcess([pane("w1:p1")], "w1:p1")).toBe("w1:p1");
    expect(paneNeedingProcess([pane("w1:p1"), claude("w1:p2", "A task")], "w1:p1")).toBeNull();
    expect(paneNeedingProcess([claude("w1:p1", "Claude Code")], "w1:p1")).toBeNull();
  });
});

describe("which tabs are ours", () => {
  const state: NamingState = { labels: { "w1:t1": "Add CSV export" }, recent: ["Add CSV export", "shop"] };

  test("default labels are numbers or empty", () => {
    expect(isDefaultLabel("1")).toBe(true);
    expect(isDefaultLabel("12")).toBe(true);
    expect(isDefaultLabel("")).toBe(true);
    expect(isDefaultLabel("api")).toBe(false);
    expect(isDefaultLabel("v2")).toBe(false);
  });

  test("a tab is managed while it has a default label or one we wrote", () => {
    expect(isManaged("w2:t1", "3", state)).toBe(true);
    expect(isManaged("w1:t1", "Add CSV export", state)).toBe(true);
  });

  test("a label the user typed is left alone", () => {
    expect(isManaged("w1:t1", "my notes", state)).toBe(false);
  });

  test("a label we wrote is still ours after tab ids shift", () => {
    expect(isManaged("w7:t3", "shop", state)).toBe(true);
  });
});

test("truncateLabel counts characters, not bytes", () => {
  expect(truncateLabel("short", 10)).toBe("short");
  expect(truncateLabel("日本語のタブ名です", 5)).toBe("日本語の…");
});
