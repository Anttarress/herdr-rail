# herdr-rail

A sidebar for [herdr](https://herdr.dev): a file explorer and a source-control
panel in one docked pane, plus automatic tab names.

It is one TypeScript program with no runtime dependencies, compiled by Bun
into a single binary. Requires herdr 0.9 or newer, on macOS or Linux.

## Where this came from

herdr-rail is a smaller reimplementation of
[herdr-sidebar](https://github.com/alexarthurs/herdr-sidebar) by Alex Arthurs
(MIT licence). The idea and most of the feature set are his: a VS Code-style
sidebar docked in a herdr pane, with a file explorer, a source-control panel,
file and diff previews in a reused tab, and commit messages drafted by the
local `claude` CLI.

The code is separate: written from scratch in TypeScript rather than Rust,
with none of herdr-sidebar's source in it. Three techniques were learned from
that project and its notes: docking on the left by splitting a pane and
swapping the two, keeping background git reads off the index lock, and the
flags for a one-shot `claude` call.

What herdr-rail adds is automatic tab names. What it leaves out is a lot:
herdr-sidebar also has an editor, Markdown, image and video previews,
side-by-side diffs, branch, stash and history management, and Windows support.
If you want the full sidebar, use herdr-sidebar.

## Install

You need [Bun](https://bun.sh) to build it.

```sh
herdr plugin install Anttarress/herdr-rail
```

Or from a checkout:

```sh
bun run build      # writes bin/herdr-rail
herdr plugin link .
```

Open the sidebar in the tab you are looking at:

```sh
herdr plugin action invoke herdr-rail.toggle
```

To put that on a key, add this to `~/.config/herdr/config.toml` and run
`herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+e"
type = "plugin_action"
command = "herdr-rail.toggle"
description = "toggle sidebar"
```

The same action opens the sidebar, focuses it when it is open, and closes it
when it has focus.

## Automatic tab names

Each tab is named after, in this order:

1. the task an agent in it reports. Claude Code and similar agents set the
   terminal title to a summary of what they are doing; that summary becomes
   the tab name;
2. the command running in its focused pane, such as `npm run dev`;
3. the folder that pane is in.

A tab you rename yourself is left alone. Only tabs that still have herdr's
default number, or a name herdr-rail wrote, are renamed. To hand a tab back,
run `herdr plugin action invoke herdr-rail.auto-name-tab` in it.

Names update when a pane gains focus, when a pane opens or closes, and when an
agent starts or finishes a turn. herdr has no event for a title change, so a
new agent title can take a few seconds to show; an open sidebar picks it up
within about four seconds.

To see what would be renamed without renaming anything:

```sh
bin/herdr-rail name-tabs --dry-run
```

## The sidebar

Three views, switched with `1` `2` `3`, `tab`, or a click. Press `?` in any
view for its keys.

**Files** shows the folder of the pane next to the sidebar and follows it when
that pane changes directory. Changed files carry their git status.

| Key | Action |
|---|---|
| `↑↓` `j` `k` | move |
| `←→` `h` `l` | fold, unfold |
| `enter` | open a folder, preview a file |
| `/` | find a file by name |
| `.` | show or hide hidden files |
| `-` | go to the parent folder |
| `y` | copy the path |

**Git** lists staged and unstaged changes.

| Key | Action |
|---|---|
| `enter` | stage or unstage the file, or the whole section |
| `o` | open the diff |
| `a` `u` | stage all, unstage all |
| `d` | discard a change (asks first) |
| `c` | write the message; `enter` commits |
| `A` | draft the message from the staged diff with the local `claude` CLI |
| `P` `L` | push, pull with `--ff-only` (both ask first) |

**Settings** changes are saved at once.

Everywhere: `r` refreshes, `b` hides the sidebar in this tab, `q` closes it.
The mouse works too: click a tab or a row, double-click a file to preview it,
scroll with the wheel.

A preview opens in its own tab and is reused for the next file. In it, `q`
closes, the arrows scroll and pan, `g` and `G` jump to the ends.

## Settings

Change them in the Settings view, or edit `settings.json` in the folder that
`herdr plugin config-dir herdr-rail` prints.

| Setting | Default | Meaning |
|---|---|---|
| `autoName` | `true` | name tabs automatically |
| `nameMaxLength` | `28` | longest tab name, 8 to 60 characters |
| `nameFromProcess` | `true` | use a running command as a tab name |
| `dock` | `"left"` | side the sidebar docks on, `"left"` or `"right"` |
| `width` | `34` | sidebar width in columns, 20 to 80 |
| `autoOpen` | `false` | dock a sidebar into every tab you focus |
| `followCwd` | `true` | follow the neighbouring pane's folder |
| `showHidden` | `true` | list dotfiles (`.git` is never listed) |

## Limits

- The sidebar opens only in the tab on screen. herdr switches to a pane's tab
  whenever that pane is swapped or focused, so docking into a background tab
  would pull you there.
- herdr cannot insert a pane at the root of a layout. In a tab whose left edge
  is already split top and bottom, the sidebar docks beside the taller pane
  and is not full height.
- herdr keeps every split between 10% and 90%, so the sidebar cannot be
  narrower than a tenth of the pane it docks against.
- The preview is read-only and highlights syntax lightly (comments, strings,
  numbers, keywords). There is no editor, no file create, rename or delete,
  and no branch switching.

## Development

```sh
bun install        # dev tools only: TypeScript and Bun's types
bun test           # unit tests, including git operations against a scratch repository
bun run typecheck
bun run build      # rebuild; herdr runs the new binary on its next call
```

A sidebar that is already open keeps running the old binary until you close
and reopen it.

To try changes against a real herdr without touching your own session, start
a second one under a fake terminal, from a shell outside herdr:

```sh
script -q /dev/null zsh -c 'stty rows 42 cols 150; exec herdr --session rail-test'
```

Then point `HERDR_SOCKET_PATH` at
`~/.config/herdr/sessions/rail-test/herdr.sock` and drive it over the socket
(`pane.send_input` for keys, `pane.send_text` for raw input such as mouse
reports, `pane.read` to see the screen). The plugin registry and settings are
shared between sessions; tab and pane state is kept per session. Remove it
with `herdr session stop rail-test` and `herdr session delete rail-test`.

`src/naming.ts` holds the naming rules, `src/dock.ts` the pane placement,
`src/sidebar/` the three views, `src/preview.ts` the viewer, and `src/tui/`
the terminal layer. `herdr-plugin.toml` lists the panes, actions and events
herdr calls; all of them run `bin/herdr-rail` with a subcommand.

On macOS the build re-signs the binary: Apple silicon refuses to run an
unsigned one, and the signature Bun 1.3 writes is not accepted by macOS 27.
