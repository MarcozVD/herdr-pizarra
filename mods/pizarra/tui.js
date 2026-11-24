#!/usr/bin/env node
// The board in a terminal pane: node tui.js [--dir <.pizarra folder>]
// Herdr's plugin runs it; it also works in any terminal with a mouse.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TermUI } from "./term.js";
import { hashText } from "./hash.js";
import { parse, serialize } from "./model.js";
import { compose, headline } from "./message.js";
import { boardDir } from "./where.js";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.url)).replaceAll("\\", "/");
const at = process.argv.indexOf("--dir");
const dir = (at > 0 ? process.argv[at + 1] : process.env.PIZARRA_DIR || boardDir()).replaceAll("\\", "/");
const file = join(dir, "board.json");
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const host = process.env.HERDR_ENV === "1" ? "herdr" : process.env.HC_TERMINAL_ID ? "hc" : null;

const run = (cmd, args, timeout = 20000) => new Promise((done) => {
  execFile(cmd, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 1 << 24 }, (error, stdout, stderr) => done({ ok: !error, stdout, stderr: stderr || error?.message || "" }));
});
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---- the file

const readText = (path = file) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
function writeText(path, text) {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

let seen = null;
let lastText;
function look() {
  const text = readText();
  if (text === lastText) return false;
  if (text !== null) {
    try {
      const { elements, own } = parse(text);
      if (!own) seen = elements;
      else if (lastText === undefined) { const s = readText(join(dir, "seen.json")); if (s) seen = parse(s).elements; }
    } catch {}
  }
  lastText = text;
  return ui.receive(text);
}

// ---- agents

let agents = []; let chosen = null;
async function findAgents() {
  if (host === "herdr") {
    const r = json((await run(HERDR, ["agent", "list"])).stdout);
    const list = r?.result?.agents ?? r?.agents ?? [];
    const mine = process.env.HERDR_WORKSPACE_ID;
    agents = list.map((a) => ({ id: a.pane_id ?? a.name, name: a.name ?? a.agent ?? a.display_agent ?? "agente", here: !mine || a.workspace_id === mine }));
  } else if (host === "hc") {
    const r = json((await run("hc", ["ls", "--json"])).stdout);
    const mine = r?.terminals?.find((t) => t.address === process.env.HC_TERMINAL_ID)?.where?.split(" / ")[0];
    agents = (r?.terminals ?? []).filter((t) => t.status && t.address !== process.env.HC_TERMINAL_ID).map((t) => ({ id: t.address, name: t.name ?? t.agent ?? "agente", here: Boolean(mine) && t.where?.split(" / ")[0] === mine }));
  }
  agents.sort((a, b) => Number(b.here) - Number(a.here));
  if (!agents.some((a) => a.id === chosen)) chosen = agents[0]?.id ?? null;
  const a = agents.find((x) => x.id === chosen);
  ui.target = host ? (a ? `${a.name} ${a.id}` : "") : null;
}

async function deliver(line) {
  if (host === "herdr") {
    const r = await run(HERDR, ["agent", "prompt", chosen, line], 60000);
    if (!r.ok) { const e = json(r.stderr); throw new Error(e?.error?.message ?? r.stderr.split("\n")[0]); }
    return;
  }
  const r = await run("hc", ["send", chosen, line, "--json"], 100000);
  const out = json(r.stdout) ?? json(r.stderr);
  if (!r.ok || out?.error) throw new Error(out?.error?.message ?? "hc send falló");
  if (out?.started !== false) return;
  const ran = async () => { const t = json((await run("hc", ["get", chosen, "--json"])).stdout); return t?.status?.state === "blocked" ? null : t?.status?.state === "working" || (t?.turn ?? 0) > out.turn; };
  const now = await ran();
  if (now) return;
  if (now === false) {
    await run("hc", ["keys", chosen, "enter"]);
    for (let i = 0; i < 6; i++) { await new Promise((d) => setTimeout(d, 500)); if (await ran()) return; }
  }
  throw new Error(`el texto quedó en ${chosen} sin arrancar; revísalo allí`);
}

async function send({ ask, said, ids, width, height }) {
  try {
    await findAgents();
    if (host && !chosen) throw new Error("no hay agentes abiertos");
    const text = readText();
    const all = text ? parse(text).elements : [];
    const part = ids ? all.filter((e) => ids.includes(e.id)) : null;
    let png = null;
    if (all.length) {
      const made = await run(process.execPath, [CLI, "png", "--dir", dir, ...(part ? ["--ids", ids.join(",").slice(0, 20000)] : [])]);
      if (!made.ok) throw new Error(made.stderr.split("\n")[0]);
      png = made.stdout.trim();
    }
    const { wish, text: body } = compose({ ask, said, all, part, seen, dir, cli: CLI, png, width, height });
    writeText(join(dir, "mensaje.md"), `${body}\n`);
    if (host) await deliver(headline({ ask, wish, dir }));
    if (all.length) { seen = all; writeText(join(dir, "seen.json"), serialize(all)); }
    ui.sent(true, host ? `Enviado a ${ui.target}` : `Dile a tu agente: lee ${dir}/mensaje.md`);
  } catch (e) { ui.sent(false, `No se envió: ${String(e.message ?? e).split("\n")[0]}`); }
  draw();
}

// ---- the screen

const out = process.stdout;
const ui = new TermUI((name, data) => {
  if (name === "save") {
    const now = readText();
    if ((now === null ? null : hashText(now)) === data.base) {
      try { writeText(file, data.text); lastText = data.text; ui.receive(data.text); } catch (e) { ui.status = `No se puede guardar: ${e.message}`; }
    } else setTimeout(() => { look(); draw(); }, 0);
  } else if (name === "send") send(data);
  else if (name === "target") {
    const i = agents.findIndex((a) => a.id === chosen);
    if (agents.length) { const a = agents[(i + 1) % agents.length]; chosen = a.id; ui.target = `${a.name} ${a.id}`; }
    findAgents().then(draw);
  } else if (name === "quit") quit();
}, { canQuit: true, hint: "V P R O L A T N I F E · rueda mueve · Ctrl+rueda zoom · 0 ver todo" });

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
let last = [];
let queued = false;
function draw() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    ui.resize(out.columns || 80, out.rows || 24);
    const rows = ui.render().map((runs) => runs.map((r) => `\x1b[0${r.b ? ";1" : ""}${r.inv ? ";7" : ""}${r.fg ? `;38;2;${rgb(r.fg)}` : ""}${r.bg ? `;48;2;${rgb(r.bg)}` : ""}m${r.t}`).join(""));
    let s = "";
    rows.forEach((r, y) => { if (r !== last[y]) s += `\x1b[${y + 1};1H${r}\x1b[0m`; });
    last = rows;
    if (s) out.write(`\x1b[?2026h${s}\x1b[?2026l`);
  }, 12);
}

// ---- input

let cell = null; // the cell's size in px, where the terminal reports the pointer in px
let pixels = false;
const NAMES = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE = { 1: "home", 3: "delete", 4: "end", 7: "home", 8: "end" };
const mod = (n) => ({ shift: Boolean((n - 1) & 1), meta: Boolean((n - 1) & 2), ctrl: Boolean((n - 1) & 4) });
let held = null;

function mouse(code, px, py, release) {
  const exact = pixels && cell;
  const x = exact ? (px - 1) / cell.w : px - 0.5; const y = exact ? (py - 1) / cell.h : py - 0.5;
  const e = { x, y, exact: Boolean(exact), shift: Boolean(code & 4), ctrl: Boolean(code & 16) };
  if (code & 64) return ui.pointer({ ...e, type: "wheel", dy: code & 1 ? 1 : -1 });
  const button = ["left", "middle", "right"][code & 3];
  if (release) { held = null; return ui.pointer({ ...e, type: "up" }); }
  if (code & 32) return ui.pointer({ ...e, type: "move" });
  held = button;
  return ui.pointer({ ...e, type: "down", button });
}

let rest = "";
let escTimer = null;
function feed(chunk) {
  clearTimeout(escTimer);
  let s = rest + chunk; rest = "";
  let changed = false;
  while (s) {
    let m;
    if ((m = /^\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])/.exec(s))) changed = mouse(+m[1], +m[2], +m[3], m[4] === "m") || changed;
    else if ((m = /^\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(s))) changed = ui.paste(m[1]) || changed;
    else if (/^\x1b\[200~/.test(s)) { rest = s; return changed && draw(); }
    else if ((m = /^\x1b\[\?1016;(\d)\$y/.exec(s))) { if (m[1] === "1" || m[1] === "2") { pixels = true; out.write("\x1b[?1016h\x1b[16t"); } }
    else if ((m = /^\x1b\[6;(\d+);(\d+)t/.exec(s))) { if (+m[1] && +m[2]) cell = { h: +m[1], w: +m[2] }; else { pixels = false; out.write("\x1b[?1016l"); } }
    else if ((m = /^\x1b\[(?:1;(\d+))?([ABCDHF])/.exec(s))) changed = ui.key(NAMES[m[2]], mod(+(m[1] ?? 1))) || changed;
    else if ((m = /^\x1b\[(\d+)(?:;(\d+))?~/.exec(s))) { if (TILDE[m[1]]) changed = ui.key(TILDE[m[1]], mod(+(m[2] ?? 1))) || changed; }
    else if ((m = /^\x1b\[(\d+)(?:;(\d+))?(?::\d+)?u/.exec(s))) { const c = +m[1]; changed = ui.key({ 13: "return", 9: "tab", 27: "escape", 127: "backspace" }[c] ?? String.fromCodePoint(c), mod(+(m[2] ?? 1))) || changed; }
    else if ((m = /^\x1bO([ABCDHF])/.exec(s))) changed = ui.key(NAMES[m[1]], {}) || changed;
    else if ((m = /^\x1b\[[0-9;?<>=$ ]*[@-~]/.exec(s))) { /* an answer nobody asked for */ }
    else if (/^\x1b(\[[0-9;?<>=$ ]*)?$/.test(s)) { rest = s; escTimer = setTimeout(() => { if (rest === "\x1b") { rest = ""; if (ui.key("escape", {})) draw(); } }, 60); break; }
    else if (s[0] === "\x1b") { m = ["\x1b"]; changed = ui.key("escape", {}) || changed; }
    else {
      const c = String.fromCodePoint(s.codePointAt(0)); m = [c];
      const n = c.codePointAt(0);
      if (n === 3) return quit();
      if (c === "\r" || c === "\n") changed = ui.key("return", {}) || changed;
      else if (c === "\t") changed = ui.key("tab", {}) || changed;
      else if (n === 127 || n === 8) changed = ui.key("backspace", {}) || changed;
      else if (n < 27) changed = ui.key(String.fromCharCode(n + 96), { ctrl: true }) || changed;
      else if (n >= 32) changed = ui.key(c, {}) || changed;
    }
    s = s.slice(m[0].length);
  }
  if (changed) draw();
}

// Windows consoles only pass mouse sequences on with VT input enabled, which Node leaves off.
function windowsMouse() {
  const code = "$s='[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode)]public static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr p,uint d,uint f,IntPtr t);[DllImport(\"kernel32.dll\")]public static extern bool GetConsoleMode(IntPtr h,out uint m);[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleMode(IntPtr h,uint m);';"
    + "$k=Add-Type -MemberDefinition $s -Name K -Namespace P -PassThru;$h=$k::CreateFileW('CONIN$',3221225472,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero);$m=0;[void]$k::GetConsoleMode($h,[ref]$m);[void]$k::SetConsoleMode($h,($m -bor 0x200) -band (-bnot 0x57))";
  return new Promise((done) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { stdio: "ignore" });
    p.on("exit", done); p.on("error", done);
  });
}

const ON = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1016$p";
const OFF = "\x1b[?1016l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l";
let closing = false;
function quit() {
  if (closing) return;
  closing = true;
  if (ui.typing === "text") ui.finishText();
  out.write(OFF, () => process.exit(0));
}

if (!process.stdin.isTTY || !out.isTTY) { console.error("pizarra: needs a terminal"); process.exit(1); }
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", feed);
process.stdin.on("end", quit);
for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, quit);
out.on("resize", () => { last = []; out.write("\x1b[2J"); if (pixels) out.write("\x1b[16t"); draw(); });
out.write(`${ON}\x1b[2J`);
if (process.platform === "win32") windowsMouse().then(() => out.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1016$p"));
ui.resize(out.columns || 80, out.rows || 24);
look();
draw();
findAgents().then(draw);
setInterval(() => { if (look()) { draw(); if (ui.flash.size) setTimeout(() => { ui.flash = new Set(); draw(); }, 5000); } }, 700);
setInterval(() => findAgents().then(draw), 8000);
