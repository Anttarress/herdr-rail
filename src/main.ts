// herdr-rail: every pane, action and hook in herdr-plugin.toml starts here.

import { toggleSidebar } from "./dock.ts";
import { snapshot } from "./herdr.ts";
import { runHook } from "./hooks.ts";
import { nameTabs } from "./namer.ts";
import { runPreview } from "./preview.ts";
import { loadSettings } from "./settings.ts";
import { runSidebar } from "./sidebar/app.ts";
import { VERSION } from "./version.ts";

const USAGE = `herdr-rail ${VERSION} — a sidebar for herdr

Usage: herdr-rail <command>

  sidebar               Run the sidebar in this terminal (herdr opens it as a pane)
  preview [file]        Run the file preview in this terminal
  toggle                Open, focus or close the sidebar in the focused tab
  name-tabs [--dry-run] Name tabs now; --dry-run only prints what would change
  auto-name-tab         Hand a tab you renamed back to automatic naming
  hook                  Run for a herdr event (see herdr-plugin.toml)
`;

async function main(): Promise<void> {
  const [command = "sidebar", ...args] = process.argv.slice(2);
  switch (command) {
    case "sidebar":
      runSidebar();
      return;
    case "preview":
      await runPreview(args);
      return;
    case "toggle":
      console.log(await toggleSidebar());
      return;
    case "hook":
      await runHook();
      return;
    case "name-tabs": {
      const dryRun = args.includes("--dry-run");
      const renames = await nameTabs({ dryRun, settings: { ...loadSettings(), autoName: true } });
      for (const rename of renames) {
        console.log(`${rename.tab_id}  ${JSON.stringify(rename.from)} -> ${JSON.stringify(rename.to)}`);
      }
      if (renames.length === 0) console.log("Every tab already has its name.");
      else if (dryRun) console.log("Dry run: nothing was renamed.");
      return;
    }
    case "auto-name-tab": {
      const snap = await snapshot();
      const tabId = process.env.HERDR_TAB_ID || snap.focused_tab_id;
      if (!tabId) throw new Error("no focused tab");
      const renames = await nameTabs({ snapshot: snap, adopt: tabId });
      const mine = renames.find((rename) => rename.tab_id === tabId);
      console.log(mine ? `${tabId} -> ${JSON.stringify(mine.to)}` : `${tabId} is named automatically again`);
      return;
    }
    case "version":
    case "--version":
    case "-V":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((error: Error) => {
  // herdr keeps stderr in the plugin log (`herdr plugin log list`).
  console.error(`herdr-rail: ${error.message}`);
  process.exitCode = 1;
});
