// Which .pizarra folder is the board's, so a person and their agents agree on it.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** What the open Herdr desktop window shows. */
export const world = () => JSON.parse(execFileSync("herdr-app", ["ls"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }));

/** Up from a folder: the nearest .pizarra, else the repository's root, else the folder. The home
 *  folder's board is only for who is right there, or it would be every project's. */
export function nearest(from) {
  const home = resolve(homedir());
  let repo = null;
  for (let at = resolve(from); ;) {
    if ((at !== home || at === resolve(from)) && existsSync(join(at, ".pizarra"))) return join(at, ".pizarra");
    if (!repo && existsSync(join(at, ".git"))) repo = at;
    const up = resolve(at, "..");
    if (up === at || at === home) break;
    at = up;
  }
  return join(repo ?? resolve(from), ".pizarra");
}

export function boardDir(cwd = process.cwd()) {
  const me = process.env.HC_TERMINAL_ID;
  if (me && process.env.HERDR_ENV !== "1") {
    try {
      const has = (list) => list.some((t) => t === me || t?.terminal === me || has(t?.sub_agents ?? []));
      const space = world().spaces.find((s) => s.tabs.some((t) => has(t.terminals)));
      if (space && !space.machine) return join(space.folder || homedir(), ".pizarra");
    } catch {}
  }
  // A Herdr plugin starts in its own folder: the workspace's is in its context.
  if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
    try {
      const c = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON);
      const at = c.focused_pane_cwd ?? c.workspace_cwd ?? c.pane?.cwd ?? c.focused_pane?.cwd ?? c.worktree?.path ?? c.workspace?.cwd;
      if (at) return nearest(at);
    } catch {}
  }
  return nearest(cwd);
}
