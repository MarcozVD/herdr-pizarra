// The Herdr plugin's action: opens the board beside the focused pane, on that pane's project.
import { execFileSync } from "node:child_process";
import { boardDir } from "./where.js";

const context = (() => { try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON); } catch { return {}; } })();
const pane = context.focused_pane_id ?? process.env.HERDR_PANE_ID;
const args = ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID || "marcozvd.pizarra", "--entrypoint", "board", "--placement", "split", "--direction", "right", "--focus"];
if (pane) args.push("--target-pane", pane);
args.push("--env", `PIZARRA_DIR=${boardDir()}`);
execFileSync(process.env.HERDR_BIN_PATH || "herdr", args, { stdio: "inherit", windowsHide: true });
