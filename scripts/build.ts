// Compile src/main.ts into the single binary herdr-plugin.toml points at.

import { spawnSync } from "node:child_process";

const OUT = "bin/herdr-rail";

function run(program: string, args: string[]): void {
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${program} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

run("bun", ["build", "src/main.ts", "--compile", "--outfile", OUT]);

if (process.platform === "darwin") {
  // Apple silicon kills a binary without a valid signature, and the one Bun
  // 1.3 writes is not accepted by macOS 27. Replace it with a fresh ad-hoc one.
  const valid = spawnSync("codesign", ["--verify", OUT], { stdio: "ignore" }).status === 0;
  if (!valid) {
    spawnSync("codesign", ["--remove-signature", OUT], { stdio: "ignore" });
    run("codesign", ["--sign", "-", "--force", OUT]);
  }
}

const check = spawnSync(OUT, ["--version"], { encoding: "utf8" });
if (check.status !== 0) {
  console.error(`${OUT} was built but does not run (exit ${check.status ?? check.signal})`);
  process.exit(1);
}
console.log(`built ${OUT} ${check.stdout.trim()}`);
