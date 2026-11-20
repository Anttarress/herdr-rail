// Shared pieces of the views: a scrolling selection and a one-line text field.

import type { KeyEvent } from "./keys.ts";
import { stringWidth } from "./width.ts";

/** Selection and scroll offset for a list of `count` rows. */
export class ListState {
  selected = 0;
  scroll = 0;

  clamp(count: number): void {
    this.selected = Math.max(0, Math.min(this.selected, count - 1));
  }

  move(delta: number, count: number): void {
    this.selected += delta;
    this.clamp(count);
  }

  /** Scroll just enough to keep the selection inside a window of `height` rows. */
  reveal(count: number, height: number): void {
    this.clamp(count);
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + height) this.scroll = this.selected - height + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, count - height)));
  }

  /** Movement keys shared by every list. Returns true when the key was one. */
  navigate(event: KeyEvent, count: number, page: number): boolean {
    switch (event.name) {
      case "up":
      case "k":
        this.move(-1, count);
        return true;
      case "down":
      case "j":
        this.move(1, count);
        return true;
      case "pageup":
        this.move(-page, count);
        return true;
      case "pagedown":
        this.move(page, count);
        return true;
      case "home":
      case "g":
        this.selected = 0;
        return true;
      case "end":
      case "G":
        this.selected = Math.max(0, count - 1);
        return true;
      default:
        return false;
    }
  }
}

export class TextInput {
  /** Code points, so the cursor never lands inside a surrogate pair. */
  private chars: string[] = [];
  private cursor = 0;

  constructor(initial = "") {
    this.set(initial);
  }

  get value(): string {
    return this.chars.join("");
  }

  set(value: string): void {
    this.chars = [...value];
    this.cursor = this.chars.length;
  }

  insert(text: string): void {
    const added = [...text.replace(/[\r\n\t]+/g, " ")];
    this.chars.splice(this.cursor, 0, ...added);
    this.cursor += added.length;
  }

  /** Column of the cursor within the value. */
  cursorColumn(): number {
    return stringWidth(this.chars.slice(0, this.cursor).join(""));
  }

  /** Editing keys. Returns true when the key changed the field or moved the cursor. */
  key(event: KeyEvent): boolean {
    if (event.ctrl) {
      switch (event.name) {
        case "a":
          this.cursor = 0;
          return true;
        case "e":
          this.cursor = this.chars.length;
          return true;
        case "u":
          this.chars.splice(0, this.cursor);
          this.cursor = 0;
          return true;
        case "w": {
          let start = this.cursor;
          while (start > 0 && this.chars[start - 1] === " ") start -= 1;
          while (start > 0 && this.chars[start - 1] !== " ") start -= 1;
          this.chars.splice(start, this.cursor - start);
          this.cursor = start;
          return true;
        }
        default:
          return false;
      }
    }
    switch (event.name) {
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case "right":
        this.cursor = Math.min(this.chars.length, this.cursor + 1);
        return true;
      case "home":
        this.cursor = 0;
        return true;
      case "end":
        this.cursor = this.chars.length;
        return true;
      case "backspace":
        if (this.cursor > 0) {
          this.chars.splice(this.cursor - 1, 1);
          this.cursor -= 1;
        }
        return true;
      case "delete":
        this.chars.splice(this.cursor, 1);
        return true;
      default:
        if (event.text && !event.alt) {
          this.insert(event.text);
          return true;
        }
        return false;
    }
  }
}
