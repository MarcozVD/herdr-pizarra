import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../mods/pizarra/cli.js", import.meta.url));
const dir = join(mkdtempSync(join(tmpdir(), "pizarra-")), ".pizarra");
const run = (args, input) => execFileSync(process.execPath, [CLI, ...args, "--dir", dir], { input, encoding: "utf8", env: { ...process.env, HC_TERMINAL_ID: "t9" } });
const board = () => JSON.parse(readFileSync(join(dir, "board.json"), "utf8")).elements;

test("apply adds and changes by id, rm removes, png renders", () => {
  run(["apply", "-"], JSON.stringify([{ id: "a", type: "rect", x: 0, y: 0, w: 200, h: 60, text: "Botón <1> & \"dos\"" }, { id: "b", type: "text", x: 0, y: 80, text: "hola" }]));
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
  assert.equal(board()[0].by, "t9");
  run(["apply", "-"], JSON.stringify({ elements: [{ id: "a", x: 40 }] }));
  assert.deepEqual([board()[0].x, board()[0].w, board()[0].type], [40, 200, "rect"]);
  const png = run(["png"]).trim();
  assert.ok(existsSync(png));
  assert.equal(readFileSync(png).subarray(1, 4).toString(), "PNG");
  run(["rm", "b"]);
  assert.deepEqual(board().map((e) => e.id), ["a"]);
});

test("bad input fails without touching the board", () => {
  const before = readFileSync(join(dir, "board.json"), "utf8");
  for (const input of ["{ nope", "{}", "[{\"type\":\"blob\"}]"]) {
    assert.equal(spawnSync(process.execPath, [CLI, "set", "-", "--dir", dir], { input, encoding: "utf8" }).status, 1);
  }
  assert.equal(readFileSync(join(dir, "board.json"), "utf8"), before);
  writeFileSync(join(dir, "board.json"), "{ broken");
  assert.equal(spawnSync(process.execPath, [CLI, "apply", "-", "--dir", dir], { input: "[]", encoding: "utf8" }).status, 1);
  assert.equal(readFileSync(join(dir, "board.json"), "utf8"), "{ broken");
});

test("guide names every type", () => {
  const guide = execFileSync(process.execPath, [CLI, "guide"], { encoding: "utf8" });
  for (const t of ["frame", "rect", "ellipse", "image", "text", "note", "line", "arrow", "stroke"]) assert.match(guide, new RegExp(`^  ${t} `, "m"));
});
