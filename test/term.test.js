import test from "node:test";
import assert from "node:assert/strict";
import { TermUI } from "../mods/pizarra/term.js";
import { hashText } from "../mods/pizarra/hash.js";
import { serialize, parse } from "../mods/pizarra/model.js";
import { compose, headline } from "../mods/pizarra/message.js";

function host(cols = 60, rows = 30, text = null) {
  const h = { text, sent: [] };
  h.ui = new TermUI((name, data) => {
    if (name === "save" && (h.text === null ? null : hashText(h.text)) === data.base) { h.text = data.text; h.ui.receive(data.text); }
    if (name === "send") h.sent.push(data);
  });
  h.ui.resize(cols, rows);
  h.ui.receive(text);
  return h;
}
const words = (ui) => ui.render().map((r) => r.map((x) => x.t).join("")).join("\n");

test("the screen always fills its size, whatever it is", () => {
  for (const [c, r] of [[20, 8], [30, 12], [45, 34], [90, 20], [200, 60]]) {
    const { ui } = host(c, r, serialize([{ id: "a", type: "rect", x: 0, y: 0, w: 900, h: 500, text: "Hola" }]));
    const rows = ui.render();
    assert.equal(rows.length, r);
    for (const row of rows) assert.equal(row.reduce((n, x) => n + [...x.t].length, 0), c, `${c}x${r}`);
  }
});

test("a stroke is saved, and the echo of a save isn't news", () => {
  const h = host();
  h.ui.render();
  h.ui.pointer({ type: "down", x: 5.5, y: 12.5, button: "left" });
  h.ui.pointer({ type: "move", x: 15.5, y: 14.5 });
  h.ui.pointer({ type: "up", x: 15.5, y: 14.5 });
  assert.equal(parse(h.text).elements[0].type, "stroke");
  assert.equal(parse(h.text).own, true);
  assert.equal(h.ui.board.dirty, false);
  assert.equal(h.ui.receive(h.text), false);
});

test("what an agent draws meanwhile is merged and saved, not lost", () => {
  const h = host();
  h.ui.render();
  h.text = serialize([{ id: "agent", type: "rect", x: 0, y: 0, w: 100, h: 50 }]); // not seen yet
  h.ui.pointer({ type: "down", x: 5.5, y: 12.5, button: "left" });
  h.ui.pointer({ type: "up", x: 9.5, y: 14.5 });
  h.ui.receive(h.text);
  assert.deepEqual(parse(h.text).elements.map((e) => e.type).sort(), ["rect", "stroke"]);
});

test("buttons, typing and sending", () => {
  const h = host(60, 30, serialize([{ id: "a", type: "rect", x: 0, y: 0, w: 100, h: 50 }, { id: "b", type: "rect", x: 200, y: 0, w: 100, h: 50 }]));
  const row = h.ui.render().findIndex((r) => r.some((x) => x.t === " Caja "));
  const col = h.ui.hits.find((x) => x.y === row && x.w === 6 && x.x > 7);
  h.ui.pointer({ type: "down", x: col.x + 1, y: row + 0.5, button: "left" });
  assert.equal(h.ui.board.tool, "rect");
  h.ui.key("/");
  for (const c of "hola ñ") h.ui.key(c === " " ? "space" : c);
  h.ui.key("backspace");
  assert.match(words(h.ui), /› hola/);
  h.ui.key("return");
  assert.equal(h.sent[0].said, "hola");
  assert.equal(h.sent[0].ids, null);
  h.ui.sent(true, "ok");
  assert.equal(h.ui.note.text, "");
});

test("a shape just drawn doesn't turn Send into send selection; one picked does", () => {
  const h = host(60, 30, serialize([{ id: "a", type: "rect", x: 100, y: 100, w: 100, h: 60 }]));
  h.ui.render();
  h.ui.pick("rect");
  h.ui.pointer({ type: "down", x: 4.5, y: 20.5, button: "left" });
  h.ui.pointer({ type: "up", x: 12.5, y: 24.5 });
  assert.equal(h.ui.board.sel.size, 1);
  assert.equal(h.ui.board.picked(), null);
  h.ui.pointer({ type: "down", x: 8.5, y: 22.5, button: "left" });
  h.ui.pointer({ type: "up", x: 8.5, y: 22.5 });
  assert.equal(h.ui.board.picked().length, 1);
});

test("broken JSON is told and never overwritten", () => {
  const h = host(60, 30, "{ nope");
  h.ui.render();
  assert.match(h.ui.status, /JSON/);
  h.ui.pointer({ type: "down", x: 5.5, y: 12.5, button: "left" });
  h.ui.pointer({ type: "up", x: 9.5, y: 14.5 });
  assert.equal(h.text, "{ nope");
});

test("the headline is one short line; the details list the changes", () => {
  const line = headline({ ask: true, wish: `a\nb ${"x".repeat(500)}`, dir: "/d" });
  assert.ok(!line.includes("\n") && line.length < 400);
  const a = { id: "a", type: "rect", x: 0, y: 0, w: 10, h: 10 };
  const { text } = compose({ ask: false, said: "", all: [{ ...a, x: 5 }], part: null, seen: [a], dir: "/d", cli: "/c", png: "/p", width: 100, height: 300 });
  assert.match(text, /~ changed rect a/);
  assert.match(text, /vertical/);
});
