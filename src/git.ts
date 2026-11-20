// Git plumbing. Every command is an argv array (no shell), and every path
// goes after `--` so a file name can never be read as an option.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/** Run a program to completion, capturing its output. Never rejects. */
export function run(program: string, args: string[], cwd: string, options: RunOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const child = spawn(program, args, { cwd, env: { ...process.env, ...options.env }, stdio: "pipe" });
    const timer = setTimeout(() => {
      stderr ||= `${program} ${args[0] ?? ""} timed out`;
      child.kill("SIGKILL");
      finish(false);
    }, options.timeoutMs ?? 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (error) => {
      stderr = error.message;
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => undefined); // the child may exit before reading
    child.stdin.end(options.input ?? "");
  });
}

function git(cwd: string, args: string[], options: RunOptions = {}): Promise<GitResult> {
  return run("git", args, cwd, options);
}

/** Reads must not take the index lock an agent in the next pane may need. */
function read(cwd: string, args: string[]): Promise<GitResult> {
  return git(cwd, args, { env: { GIT_OPTIONAL_LOCKS: "0" } });
}

/** First meaningful line of a failed command, for a one-line status message. */
export function failure(result: GitResult): string {
  const line = `${result.stderr}\n${result.stdout}`.split("\n").find((entry) => entry.trim());
  return (line ?? "git failed").replace(/^(error|fatal): /, "").trim();
}

export interface StatusEntry {
  /** Relative to the repository root. */
  path: string;
  /** Where a renamed file came from. */
  from?: string;
  /** Index (staged) status letter, `.` when unchanged. */
  index: string;
  /** Worktree status letter, `.` when unchanged. */
  worktree: string;
  untracked: boolean;
  conflict: boolean;
}

export interface RepoStatus {
  root: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: StatusEntry[];
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): Omit<RepoStatus, "root"> {
  const status: Omit<RepoStatus, "root"> = { branch: "", upstream: null, ahead: 0, behind: 0, entries: [] };
  const records = raw.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const fields = record.split(" ");
    const kind = fields[0];
    if (kind === "#") {
      if (fields[1] === "branch.head") status.branch = fields.slice(2).join(" ");
      if (fields[1] === "branch.upstream") status.upstream = fields.slice(2).join(" ");
      if (fields[1] === "branch.ab") {
        status.ahead = Math.abs(Number(fields[2])) || 0;
        status.behind = Math.abs(Number(fields[3])) || 0;
      }
    } else if (kind === "1" || kind === "2" || kind === "u") {
      // Fixed fields come first; the path is the rest and may contain spaces.
      const pathAt = kind === "1" ? 8 : kind === "2" ? 9 : 10;
      const entry: StatusEntry = {
        path: fields.slice(pathAt).join(" "),
        index: fields[1][0],
        worktree: fields[1][1],
        untracked: false,
        conflict: kind === "u",
      };
      if (kind === "2") {
        entry.from = records[i + 1];
        i += 1; // a rename is followed by its original path as its own record
      }
      status.entries.push(entry);
    } else if (kind === "?") {
      status.entries.push({ path: record.slice(2), index: ".", worktree: "?", untracked: true, conflict: false });
    }
  }
  return status;
}

export async function repoRoot(dir: string): Promise<string | null> {
  const result = await read(dir, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() : null;
}

export async function status(dir: string): Promise<RepoStatus | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const result = await read(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  if (!result.ok) return null;
  return { root, ...parseStatus(result.stdout) };
}

export function isStaged(entry: StatusEntry): boolean {
  return !entry.conflict && entry.index !== ".";
}

export function isUnstaged(entry: StatusEntry): boolean {
  return !entry.conflict && (entry.untracked || entry.worktree !== ".");
}

export function stage(root: string, paths: string[]): Promise<GitResult> {
  return git(root, ["add", "--", ...paths]);
}

export function stageAll(root: string): Promise<GitResult> {
  return git(root, ["add", "--all"]);
}

export async function unstage(root: string, paths: string[]): Promise<GitResult> {
  const result = await git(root, ["restore", "--staged", "--", ...paths]);
  if (result.ok) return result;
  // Before the first commit there is no HEAD to restore from.
  return git(root, ["rm", "--cached", "--quiet", "--", ...paths]);
}

export async function unstageAll(root: string): Promise<GitResult> {
  const result = await git(root, ["reset", "--quiet"]);
  if (result.ok) return result;
  return git(root, ["rm", "--cached", "--quiet", "-r", "--", "."]);
}

/** Throw away unstaged changes to one file. Untracked files are deleted. */
export async function discard(root: string, entry: StatusEntry): Promise<GitResult> {
  if (entry.untracked) {
    try {
      fs.rmSync(path.join(root, entry.path));
      return { ok: true, stdout: "", stderr: "" };
    } catch (error) {
      return { ok: false, stdout: "", stderr: (error as Error).message };
    }
  }
  return git(root, ["restore", "--worktree", "--", entry.path]);
}

export function commit(root: string, message: string): Promise<GitResult> {
  return git(root, ["commit", "--file", "-"], { input: message, timeoutMs: 60_000 });
}

export function push(root: string): Promise<GitResult> {
  return git(root, ["push"], { timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: "0" } });
}

export function pull(root: string): Promise<GitResult> {
  return git(root, ["pull", "--ff-only"], { timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: "0" } });
}

/** Unified diff of one file: staged, unstaged, or (for an untracked file) all of it as added. */
export async function diff(root: string, entry: Pick<StatusEntry, "path" | "untracked">, staged: boolean): Promise<string> {
  const base = ["diff", "--no-color", "--no-ext-diff"];
  if (entry.untracked) {
    // `--no-index` exits 1 when the files differ, which here is always.
    return (await read(root, [...base, "--no-index", "--", "/dev/null", entry.path])).stdout;
  }
  return (await read(root, [...base, ...(staged ? ["--cached"] : []), "--", entry.path])).stdout;
}

/** Staged diff for a commit-message draft, capped so a huge change stays cheap. */
export async function stagedDiff(root: string, maxBytes: number): Promise<string> {
  const result = await read(root, ["diff", "--cached", "--no-color", "--no-ext-diff"]);
  return result.stdout.length > maxBytes ? `${result.stdout.slice(0, maxBytes)}\n[diff truncated]` : result.stdout;
}

/** Tracked and untracked-but-not-ignored files, relative to `dir`. Null outside a repository. */
export async function listFiles(dir: string): Promise<string[] | null> {
  const result = await read(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!result.ok) return null;
  return result.stdout.split("\0").filter(Boolean);
}
