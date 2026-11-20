// What a sidebar view provides, and what the app provides to its views.

import type { StatusEntry } from "../git.ts";
import type { Settings } from "../settings.ts";
import type { KeyEvent } from "../tui/keys.ts";
import { Color, type Line, type Row, type Style } from "../tui/screen.ts";

export const Styles = {
  dim: { dim: true },
  bold: { bold: true },
  accent: { fg: Color.blue, bold: true },
  selected: { inverse: true },
  added: { fg: Color.green },
  modified: { fg: Color.yellow },
  deleted: { fg: Color.red },
  renamed: { fg: Color.cyan },
  conflict: { fg: Color.magenta, bold: true },
} as const satisfies Record<string, Style>;

export type PreviewTarget =
  | { kind: "file"; path: string }
  | { kind: "diff"; root: string; path: string; staged: boolean; untracked: boolean };

export interface Host {
  settings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  /** Show a one-line message in the footer for a few seconds. */
  flash(message: string): void;
  redraw(): void;
  /** Re-read the folder and the repository status now. */
  refresh(): Promise<void>;
  /** Show another folder. The choice sticks until the followed pane changes directory. */
  setRoot(dir: string): void;
  preview(target: PreviewTarget): void;
  confirm(question: string, onYes: () => void): void;
  prompt(label: string, initial: string, onSubmit: (value: string) => void, onCancel?: (value: string) => void): void;
  copy(text: string): void;
}

export interface View {
  /** Tab title in the activity bar. */
  tab(): string;
  header(width: number): Line;
  /** Body rows for a window of `height` rows. */
  rows(width: number, height: number): Row[];
  key(event: KeyEvent): boolean;
  /** A click on body row `row` (0 = first visible row). */
  click(row: number, double: boolean): void;
  scroll(delta: number): void;
  /** The one or two keys worth a place in the footer; `?` lists the rest. */
  hints(): string;
  /** Every key of this view, as [keys, what they do], for the help screen. */
  keys(): [string, string][];
}

/** Status letter and color for a changed file, as shown next to its name. */
export function statusBadge(entry: StatusEntry, staged: boolean): { letter: string; style: Style } {
  if (entry.conflict) return { letter: "!", style: Styles.conflict };
  if (entry.untracked) return { letter: "U", style: Styles.added };
  const letter = staged ? entry.index : entry.worktree;
  switch (letter) {
    case "A":
      return { letter, style: Styles.added };
    case "D":
      return { letter, style: Styles.deleted };
    case "R":
    case "C":
      return { letter, style: Styles.renamed };
    default:
      return { letter: letter === "." ? " " : letter, style: Styles.modified };
  }
}
