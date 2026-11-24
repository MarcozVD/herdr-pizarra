#!/usr/bin/env node
// The agents' side of the board: node cli.js guide
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, parse, serialize, describe, lint } from "./model.js";
import { toPng, toSvg } from "./render.js";
import { boardDir as findDir, world } from "./where.js";

const ME = fileURLToPath(import.meta.url).replaceAll("\\", "/");
const GUIDE = `Pizarra: a whiteboard shared with the person in Herdr. They see what you draw within a second,
change it by hand and send it back. Draw a proposal, say it's there, and wait for their answer
before building it.

  node "${ME}" show              the board as JSON (one element per line) and what's on it
  node "${ME}" apply <file|->    add elements, or change those with a known id (only the keys given)
  node "${ME}" set <file|->      replace the whole board (the person can undo it; prefer apply)
  node "${ME}" rm <id> [id ...]  remove elements
  node "${ME}" png [out.png]     render it and print the path: look at it before you say it's done
  node "${ME}" open              open the board beside the person's terminal (only if they ask)
  Any of them takes --dir <folder>: the .pizarra folder to use (default: this terminal's space).

JSON: [ element, ... ] or { "elements": [ ... ] }. "-" reads stdin. Coordinates are px, x right, y down.
  frame    { id, type, x, y, w, h, text }            a screen: desktop 1200x800, phone 390x844. Put things inside it
  rect     { id, type, x, y, w, h, text?, radius? }  boxes, buttons, inputs, cards (text centered, wraps)
  ellipse  { id, type, x, y, w, h, text? }
  image    { id, type, x, y, w, h, text? }           a picture's placeholder, crossed out
  text     { id, type, x, y, text, size? }           loose text, \\n for lines; x,y is its top left.
                                                     "fixed": true with "w" wraps it at that width
  note     { id, type, x, y, w, h, text }            a sticky note: questions and reasons, outside the frame
  line     { id, type, x, y, x2, y2, text? }
  arrow    { id, type, x, y, x2, y2, text? }         head at x2,y2: flows between frames or boxes
  stroke   { id, type, points: [[x,y], ...] }        freehand
  Any: color and fill = ink gray red orange yellow green blue purple, or #rrggbb. fill is a tint;
  "solid": true paints it full (its text turns white). stroke (line px), size (text px, 16), dash (true).
Use short meaningful ids (hero-title): the person's changes are reported by id. Later elements go on top.
The board is usually a narrow panel beside the terminal: stack screens vertically unless told otherwise.
Leave 16px of room around text. Don't move or remove what the person drew unless asked.`;

const args = process.argv.slice(2);
const take = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args.splice(i, 2)[1]; };
const dirArg = take("--dir");
const idsArg = take("--ids");
const [command, ...rest] = args;

function fail(message) { console.error(`pizarra: ${message}`); process.exit(1); }

const boardDir = () => (dirArg ? resolve(dirArg) : findDir());

const dir = command && !["guide", "help", "--help"].includes(command) ? boardDir() : "";
const file = join(dir, "board.json");

function init() {
  mkdirSync(dir, { recursive: true });
  // Keeps the folder out of git without touching the project's own .gitignore.
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
}

function read() {
  if (!existsSync(file)) return [];
  try { return parse(readFileSync(file, "utf8")).elements; } catch (e) { return fail(`${file} isn't valid JSON (${e.message}); fix it, or use set`); }
}

function write(elements) {
  init();
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, serialize(elements));
  renameSync(temp, file);
}

function input(name) {
  if (!name) fail(`${command} needs a file, or - for stdin`);
  let raw;
  try { raw = JSON.parse(readFileSync(name === "-" ? 0 : name, "utf8").replace(/^﻿/, "")); } catch (e) { fail(`can't read that JSON: ${e.message}`); }
  const list = Array.isArray(raw) ? raw : raw?.elements;
  if (!Array.isArray(list)) fail("expected [ ... ] or { \"elements\": [ ... ] }");
  return list;
}

const by = process.env.HC_TERMINAL_ID || "agent";
const known = (e) => e && typeof e === "object";

function report(elements, problems) {
  for (const p of [...problems, ...lint(elements)]) console.log(`! ${p}`);
  console.log(`${elements.length} elements in ${file.replaceAll("\\", "/")}`);
}

switch (command) {
  case "dir":
    console.log(dir.replaceAll("\\", "/"));
    break;
  case "init":
    init();
    console.log(dir);
    break;
  case "show": {
    const elements = read();
    process.stdout.write(serialize(elements));
    console.log(describe(elements).join("\n") || "(the board is empty)");
    break;
  }
  case "set": {
    const list = input(rest[0]);
    const { elements, problems } = normalize(list.map((e) => (known(e) ? { by, ...e } : e)));
    if (!elements.length && problems.length) fail(problems.join("\n"));
    write(elements);
    report(elements, problems);
    break;
  }
  case "apply": {
    const kept = read();
    const now = new Map(kept.map((e) => [e.id, e]));
    const { elements, problems } = normalize(input(rest[0]).map((e) => (known(e) ? { ...now.get(String(e.id)), ...e, by } : e)));
    for (const e of elements) {
      const i = kept.findIndex((k) => k.id === e.id);
      if (i < 0) kept.push(e); else kept[i] = e;
    }
    write(kept);
    report(kept, problems);
    break;
  }
  case "rm": {
    const before = read();
    const after = before.filter((e) => !rest.includes(e.id));
    write(after);
    console.log(`removed ${before.length - after.length}`);
    break;
  }
  case "png":
  case "svg": {
    let elements = read();
    if (idsArg) { const ids = new Set(idsArg.split(",")); elements = elements.filter((e) => ids.has(e.id)); }
    if (!elements.length) fail("nothing to render");
    init();
    const out = resolve(rest[0] ?? join(dir, `board.${command}`));
    writeFileSync(out, command === "png" ? await toPng(elements) : toSvg(elements));
    console.log(out.replaceAll("\\", "/"));
    break;
  }
  case "open": {
    const mine = world().spaces.flatMap((s) => s.tabs).flatMap((t) => t.terminals).find((t) => t.terminal === process.env.HC_TERMINAL_ID);
    if (!mine?.pane) fail("this terminal has no pane to open the board beside; ask the person to press ctrl-shift-d");
    execFileSync("herdr-app", ["do", "pane.split", JSON.stringify({ direction: "right", pane: mine.pane, mod: "pizarra", props: { dir } })], { stdio: "inherit" });
    break;
  }
  case "guide":
  case "help":
  case "--help":
  case undefined:
    console.log(GUIDE);
    break;
  default:
    fail(`unknown command ${command}; try guide`);
}
