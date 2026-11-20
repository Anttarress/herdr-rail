import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "../src/git.ts";
import { buildRows, cleanDraft } from "../src/sidebar/scm.ts";

describe("parseStatus", () => {
  const raw = [
    "# branch.oid 1234abcd",
    "# branch.head feature/tabs",
    "# branch.upstream origin/feature/tabs",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
    "1 A. N... 000000 100644 100644 000 ccc docs/new file.md",
    "1 MM N... 100644 100644 100644 ddd eee both.ts",
    "2 R. N... 100644 100644 100644 fff ggg R100 lib/renamed.ts",
    "lib/old name.ts",
    "u UU N... 100644 100644 100644 100644 hhh iii jjj conflict.ts",
    "? notes/todo.txt",
    "! ignored.log",
    "",
  ].join("\0");

  const status = git.parseStatus(raw);

  test("reads the branch line", () => {
    expect(status.branch).toBe("feature/tabs");
    expect(status.upstream).toBe("origin/feature/tabs");
    expect([status.ahead, status.behind]).toEqual([2, 1]);
  });

  test("reads each kind of entry, with spaces in paths", () => {
    expect(status.entries.map((entry) => entry.path)).toEqual([
      "src/app.ts",
      "docs/new file.md",
      "both.ts",
      "lib/renamed.ts",
      "conflict.ts",
      "notes/todo.txt",
    ]);
    expect(status.entries[3].from).toBe("lib/old name.ts");
    expect(status.entries[4].conflict).toBe(true);
    expect(status.entries[5].untracked).toBe(true);
  });

  test("sorts entries into staged and unstaged", () => {
    const paths = (filter: (entry: git.StatusEntry) => boolean) =>
      status.entries.filter(filter).map((entry) => entry.path);
    expect(paths(git.isStaged)).toEqual(["docs/new file.md", "both.ts", "lib/renamed.ts"]);
    expect(paths(git.isUnstaged)).toEqual(["src/app.ts", "both.ts", "notes/todo.txt"]);
  });

  test("a branch with no upstream and no commits", () => {
    const fresh = git.parseStatus(["# branch.oid (initial)", "# branch.head main", ""].join("\0"));
    expect(fresh).toEqual({ branch: "main", upstream: null, ahead: 0, behind: 0, entries: [] });
  });

  test("becomes the rows of the source-control view", () => {
    const kinds = buildRows({ root: "/r", ...status }).map((row) =>
      row.kind === "section" ? `${row.title} ${row.count}` : row.kind,
    );
    expect(kinds).toEqual([
      "message",
      "Merge Conflicts 1",
      "file",
      "Staged Changes 3",
      "file",
      "file",
      "file",
      "Changes 3",
      "file",
      "file",
      "file",
    ]);
    expect(buildRows(null)).toEqual([{ kind: "note", text: "Not a git repository" }]);
    expect(buildRows({ root: "/r", ...status, entries: [] }).pop()).toEqual({ kind: "note", text: "No changes" });
  });
});

test("cleanDraft keeps the message line and drops quoting", () => {
  expect(cleanDraft("Add CSV export\n")).toBe("Add CSV export");
  expect(cleanDraft('"Fix the redirect."')).toBe("Fix the redirect");
  expect(cleanDraft("```\nRefactor dock\n```")).toBe("Refactor dock");
  expect(cleanDraft("  \n\n")).toBeNull();
});

describe("against a real repository", () => {
  let root = "";
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const paths = async (filter: (entry: git.StatusEntry) => boolean) =>
    ((await git.status(root))?.entries ?? []).filter(filter).map((entry) => entry.path);

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-rail-git-")));
    const setup = [
      ["init", "--quiet", "--initial-branch=main"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["config", "commit.gpgsign", "false"],
    ];
    for (const args of setup) expect((await git.run("git", args, root)).ok).toBe(true);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("outside a repository there is no status", async () => {
    expect(await git.status(os.tmpdir())).toBeNull();
  });

  test("stage, unstage and commit before and after the first commit", async () => {
    write("a.txt", "one\n");
    write("-dash.txt", "a name that looks like an option\n");
    expect(await paths(git.isUnstaged)).toEqual(["-dash.txt", "a.txt"]);

    expect((await git.stage(root, ["a.txt", "-dash.txt"])).ok).toBe(true);
    expect(await paths(git.isStaged)).toEqual(["-dash.txt", "a.txt"]);

    // No HEAD yet: unstaging must still work.
    expect((await git.unstage(root, ["-dash.txt"])).ok).toBe(true);
    expect(await paths(git.isStaged)).toEqual(["a.txt"]);

    expect((await git.stageAll(root)).ok).toBe(true);
    expect((await git.commit(root, "First commit")).ok).toBe(true);
    expect((await git.status(root))?.entries).toEqual([]);
    expect((await git.status(root))?.branch).toBe("main");
  });

  test("diffs for unstaged, staged and untracked files", async () => {
    write("a.txt", "one\ntwo\n");
    write("new.txt", "fresh\n");
    expect(await git.diff(root, { path: "a.txt", untracked: false }, false)).toContain("+two");
    expect(await git.diff(root, { path: "a.txt", untracked: false }, true)).toBe("");
    expect(await git.diff(root, { path: "new.txt", untracked: true }, false)).toContain("+fresh");

    await git.stage(root, ["a.txt"]);
    expect(await git.diff(root, { path: "a.txt", untracked: false }, true)).toContain("+two");
    expect(await git.stagedDiff(root, 10_000)).toContain("+two");
    expect(await git.stagedDiff(root, 20)).toEndWith("[diff truncated]");
  });

  test("unstage everything, then discard", async () => {
    expect((await git.unstageAll(root)).ok).toBe(true);
    expect(await paths(git.isStaged)).toEqual([]);

    const entries = (await git.status(root))?.entries ?? [];
    for (const entry of entries) expect((await git.discard(root, entry)).ok).toBe(true);
    expect((await git.status(root))?.entries).toEqual([]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  test("lists tracked and untracked files but not ignored ones", async () => {
    write(".gitignore", "*.log\n");
    write("debug.log", "noise\n");
    write("src/x.ts", "export {}\n");
    expect((await git.listFiles(root))?.sort()).toEqual(["-dash.txt", ".gitignore", "a.txt", "src/x.ts"]);
    expect(await git.listFiles(os.tmpdir())).toBeNull();
  });

  test("a failed command reports its first line", async () => {
    const result = await git.commit(root, "Nothing staged");
    expect(result.ok).toBe(false);
    expect(git.failure(result).length).toBeGreaterThan(0);
  });
});
