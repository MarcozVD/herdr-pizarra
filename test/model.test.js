import test from "node:test";
import assert from "node:assert/strict";
import { Board, normalize, serialize, parse, merge, diff, describe, simplify, wrap, textWidth, lint } from "../mods/pizarra/model.js";

const rect = (id, x = 0, y = 0, more = {}) => ({ id, type: "rect", x, y, w: 100, h: 50, ...more });
const at = (x, y) => ({ x: x + 60, y: y + 60 }); // the board opens with its origin at 60,60
const drag = (b, from, to, opts) => { b.down(at(...from), opts); b.move(at(...to), opts); return b.up(); };

test("normalize keeps good elements and tells the bad ones", () => {
  const { elements, problems } = normalize([rect("a"), { type: "blob" }, { type: "arrow", x: 0, y: 0 }, null, rect("a"), { type: "text", x: 0, y: 0 }, { type: "rect", x: "5", y: 5, w: -10, h: 20, color: "pink" }]);
  assert.equal(elements.length, 3);
  assert.equal(problems.length, 6);
  assert.notEqual(elements[1].id, "a");
  assert.deepEqual([elements[2].x, elements[2].w], [-5, 10]);
  assert.equal(normalize({ nope: 1 }).problems.length, 1);
});

test("what the mod saves is recognized as its own, an agent's edit isn't", () => {
  const text = serialize([rect("a", 1.23456)], true);
  assert.equal(parse(text).own, true);
  assert.equal(parse(text.replace("\"w\":100", "\"w\":101")).own, false);
  assert.equal(parse(serialize([rect("a")])).own, false);
  assert.throws(() => parse("{ broken"));
});

test("merge keeps both sides' work", () => {
  const base = [rect("a"), rect("b"), rect("c"), rect("d")];
  const mine = [rect("a", 9), rect("b"), rect("d"), rect("mine")]; // moved a, removed c
  const theirs = [rect("a"), rect("b", 7), rect("c"), rect("theirs")]; // moved b, removed d
  const out = new Map(merge(base, mine, theirs).map((e) => [e.id, e]));
  assert.equal(out.get("a").x, 9);
  assert.equal(out.get("b").x, 7);
  assert.equal(out.has("c"), false);
  assert.equal(out.has("d"), false);
  assert.ok(out.has("mine") && out.has("theirs"));
});

test("key order and authorship aren't changes", () => {
  assert.deepEqual(diff([{ id: "a", type: "stroke", points: [[1, 2]], color: "red", by: "t1" }], [{ color: "red", type: "stroke", id: "a", points: [[1, 2]] }]), []);
});

test("diff tells an agent what the person did", () => {
  const lines = diff([rect("a", 0, 0, { text: "Hi" }), rect("gone")], [rect("a", 20, 0, { text: "Bye", color: "red" }), rect("new")]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^~ changed rect a .*"Hi" -> "Bye".*\(0,0\).*-> at \(20,0\).*color none -> red/);
  assert.match(lines[1], /^\+ added rect new/);
  assert.match(lines[2], /^- removed rect gone/);
});

test("pen: a stroke, simplified, one undo step", () => {
  const b = new Board();
  b.down(at(0, 0));
  for (let x = 2; x <= 100; x += 2) b.move(at(x, 0));
  b.up();
  assert.equal(b.elements.length, 1);
  assert.deepEqual(b.elements[0].points, [[0, 0], [100, 0]]);
  b.undo();
  assert.equal(b.elements.length, 0);
  b.redo();
  assert.equal(b.elements.length, 1);
});

test("shapes: drag makes one, a click makes a default one, then select takes over", () => {
  const b = new Board();
  b.tool = "rect";
  drag(b, [100, 100], [20, 40]);
  assert.deepEqual([b.elements[0].x, b.elements[0].y, b.elements[0].w, b.elements[0].h], [20, 40, 80, 60]);
  assert.equal(b.tool, "select");
  b.tool = "note";
  b.down(at(300, 300));
  assert.equal(b.up().edit, b.elements[1].id);
  assert.equal(b.elements[1].w, 180);
});

test("a frame takes along what it holds, and doesn't block what's inside", () => {
  const b = new Board([{ id: "f", type: "frame", x: 0, y: 0, w: 400, h: 300 }, rect("in", 50, 50), rect("out", 600, 50)]);
  b.tool = "select";
  drag(b, [0, 100], [30, 110]);
  assert.deepEqual(Object.fromEntries(b.elements.map((e) => [e.id, e.x])), { f: 30, in: 80, out: 600 });
  drag(b, [100, 80], [110, 80]);
  assert.equal(b.elements.find((e) => e.id === "f").x, 30);
  assert.equal(b.elements.find((e) => e.id === "in").x, 90);
});

test("resize from a corner, and line ends", () => {
  const b = new Board([rect("a"), { id: "l", type: "line", x: 300, y: 0, x2: 400, y2: 0 }]);
  b.tool = "select";
  b.sel = new Set(["a"]);
  drag(b, [100, 50], [150, 90]);
  assert.deepEqual([b.elements[0].w, b.elements[0].h], [150, 90]);
  b.sel = new Set(["l"]);
  drag(b, [400, 0], [420, 33]);
  assert.deepEqual([b.elements[1].x2, b.elements[1].y2], [420, 33]);
});

test("a click doesn't move or dirty anything; cancel puts things back", () => {
  const b = new Board([rect("a")]);
  b.tool = "select";
  b.down(at(50, 25)); b.up();
  assert.equal(b.dirty, false);
  b.down(at(50, 25)); b.move(at(90, 25)); b.cancel();
  assert.equal(b.elements[0].x, 0);
});

test("eraser removes everything it crosses in one undo step", () => {
  const b = new Board([rect("a"), rect("b", 300), rect("c", 0, 400)]);
  b.tool = "eraser";
  drag(b, [-50, 25], [500, 25]);
  assert.deepEqual(b.elements.map((e) => e.id), ["c"]);
  b.undo();
  assert.equal(b.elements.length, 3);
});

test("text: created, edited, removed when emptied", () => {
  const b = new Board();
  b.tool = "text";
  const { create } = b.down(at(10, 10));
  b.setText(create, "Hola\nmundo  ");
  assert.equal(b.elements[0].text, "Hola\nmundo");
  assert.ok(b.elements[0].w > 20 && b.elements[0].h > 40);
  b.setText(b.elements[0], "");
  assert.equal(b.elements.length, 0);
  b.setText({ ...create }, "");
  assert.equal(b.elements.length, 0);
});

test("style on the selection: only what each type takes, and it survives a save", () => {
  const b = new Board([rect("a"), { id: "i", type: "image", x: 0, y: 0, w: 10, h: 10 }]);
  b.sel = new Set(["a", "i"]);
  b.setStyle({ fill: "blue" });
  assert.equal(b.elements[0].fill, "blue");
  assert.equal(b.elements[1].fill, undefined);
  b.setStyle({ fill: null });
  assert.equal("fill" in b.elements[0], false);
  assert.deepEqual(diff(b.elements, parse(serialize(b.elements)).elements), []);
});

test("an agent's drawing is undoable", () => {
  const b = new Board([rect("a")]);
  b.external([rect("a"), rect("agent")], false);
  assert.equal(b.dirty, false);
  b.undo();
  assert.deepEqual(b.elements.map((e) => e.id), ["a"]);
  assert.equal(b.dirty, true);
});

test("zoom keeps the point under the pointer; fit shows everything", () => {
  const b = new Board([rect("a", 1000, 1000)]);
  const p = { x: 200, y: 120 };
  const before = b.world(p);
  b.zoom(p, 1.7);
  const after = b.world(p);
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
  b.fit(800, 600);
  const x = 1000 * b.view.k + b.view.x;
  assert.ok(x >= 0 && x + 100 * b.view.k <= 800);
});

test("text wraps within its width, and long words break", () => {
  for (const l of wrap("una frase larga con supercalifragilisticoexpialidoso dentro", 90, 16)) assert.ok(textWidth(l, 16) <= 90);
  assert.equal(lint([rect("a", 0, 0, { text: "mucho texto ".repeat(20) })]).length, 1);
});

test("simplify keeps corners; describe counts strokes", () => {
  assert.deepEqual(simplify([[0, 0], [5, 0], [10, 0], [10, 10]], 0.5), [[0, 0], [10, 0], [10, 10]]);
  assert.match(describe([rect("a"), { id: "s", type: "stroke", points: [[0, 0], [9, 9]] }])[1], /^1 freehand stroke/);
});
