// The board without Herdr: elements, geometry, undo, merging and the words an
// agent reads. The mod, the CLI and the tests all use this file.

export const TYPES = ["stroke", "rect", "ellipse", "line", "arrow", "text", "note", "image", "frame"];
/** The board is white paper in every theme, so what the person sees is what the agent gets. */
export const INK = { ink: "#1f2328", gray: "#8b929b", red: "#d1344b", orange: "#d9730d", yellow: "#c79a00", green: "#2f8f4e", blue: "#2f6fde", purple: "#8250df" };
export const PAPER = "#ffffff";
export const COLORS = Object.keys(INK);
export const inkOf = (c) => INK[c] ?? c ?? INK.ink;
const BOXES = new Set(["rect", "ellipse", "text", "note", "image", "frame"]);
const LINES = new Set(["line", "arrow"]);
const FILLED = new Set(["rect", "ellipse", "note"]);
const DEFAULT_SIZE = { rect: [160, 90], ellipse: [140, 90], note: [180, 130], image: [240, 150], frame: [1200, 800] };
const LIMIT = 4000;

export const isBox = (el) => BOXES.has(el.type);
export const isLine = (el) => LINES.has(el.type);
export const hasText = (el) => el.type !== "stroke";
export const fontSize = (el) => el.size ?? (el.type === "frame" ? 14 : 16);

const num = (v) => (v === null || v === "" || typeof v === "boolean" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const tenth = (v) => Math.round(v * 10) / 10;

let counter = 0;
export function newId(taken) {
  let id;
  do id = `e${(Date.now() % 1e8).toString(36)}${(counter++ % 1296).toString(36)}`;
  while (taken?.has(id));
  return id;
}

// ---- text ----------------------------------------------------------------

const NARROW = /[iljtfr.,:;'|!()[\] ]/;
const WIDE = /[mwMW@%]/;
export function textWidth(text, size) {
  let w = 0;
  for (const c of text) w += NARROW.test(c) ? 0.31 : WIDE.test(c) ? 0.87 : /[A-Z]/.test(c) ? 0.65 : c.codePointAt(0) > 0x2e80 ? 1 : 0.55;
  return w * size;
}

export function wrap(text, width, size) {
  const out = [];
  for (const line of String(text).split("\n")) {
    let now = "";
    for (let word of line.split(" ")) {
      const next = now ? `${now} ${word}` : word;
      if (textWidth(next, size) <= width) { now = next; continue; }
      if (now) out.push(now);
      while (textWidth(word, size) > width && word.length > 1) {
        let n = word.length - 1;
        while (n > 1 && textWidth(word.slice(0, n), size) > width) n--;
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      now = word;
    }
    out.push(now);
  }
  return out;
}

export const lineHeight = (size) => tenth(size * 1.35);

/** The lines an element's text takes, as both renderers draw it. */
export function textLines(el) {
  if (!el.text) return [];
  if (isLine(el) || el.type === "frame") return el.text.split("\n").slice(0, 1);
  if (el.type === "text") return el.fixed ? wrap(el.text, el.w, fontSize(el)) : el.text.split("\n");
  return wrap(el.text, Math.max(8, el.w - 16), fontSize(el));
}

function fitText(el) {
  const size = fontSize(el);
  const lines = el.fixed ? wrap(el.text ?? "", el.w, size) : String(el.text ?? "").split("\n");
  if (!el.fixed) el.w = Math.max(10, Math.ceil(Math.max(...lines.map((l) => textWidth(l, size))) + 4));
  el.h = Math.ceil(lines.length * lineHeight(size));
  return el;
}

// ---- reading what others wrote -------------------------------------------

/** Any JSON to valid elements. Bad ones are left out and told in `problems`. */
export function normalize(raw) {
  const list = Array.isArray(raw) ? raw : raw?.elements;
  const problems = [];
  const elements = [];
  if (!Array.isArray(list)) return { elements, problems: ['expected { "elements": [...] } or a plain array'] };
  if (list.length > LIMIT) problems.push(`only the first ${LIMIT} elements are kept`);
  const taken = new Set(list.map((e) => e?.id).filter((id) => typeof id === "string"));
  const seen = new Set();
  list.slice(0, LIMIT).forEach((e, i) => {
    const name = `#${i}${e?.id ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object") return problems.push(`${name}: not an object`);
    if (!TYPES.includes(e.type)) return problems.push(`${name}: unknown type ${JSON.stringify(e.type)}; use ${TYPES.join(", ")}`);
    let id = typeof e.id === "string" || typeof e.id === "number" ? String(e.id).slice(0, 64) : "";
    if (!id || seen.has(id)) {
      if (id) problems.push(`${name}: repeated id, given a new one`);
      id = newId(taken);
      taken.add(id);
    }
    const el = { id, type: e.type };
    if (e.type === "stroke") {
      const points = (Array.isArray(e.points) ? e.points : [])
        .map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [num(p?.x), num(p?.y)]))
        .filter(([x, y]) => x !== null && y !== null);
      if (!points.length) return problems.push(`${name}: a stroke needs "points": [[x,y], ...]`);
      el.points = points;
    } else {
      el.x = num(e.x); el.y = num(e.y);
      if (el.x === null || el.y === null) return problems.push(`${name}: needs numbers "x" and "y"`);
      if (LINES.has(e.type)) {
        el.x2 = num(e.x2); el.y2 = num(e.y2);
        if (el.x2 === null || el.y2 === null) return problems.push(`${name}: a ${e.type} needs numbers "x2" and "y2"`);
      }
    }
    if (typeof e.text === "string" && e.text && hasText(el)) el.text = e.text.slice(0, 4000);
    if (num(e.size ?? null) !== null) el.size = clamp(num(e.size), 6, 200);
    if (BOXES.has(e.type)) {
      let w = num(e.w ?? null); let h = num(e.h ?? null);
      if (e.type === "text") {
        if (!el.text) return problems.push(`${name}: a text needs "text"`);
        if (w > 0 && e.fixed !== undefined) { el.fixed = true; el.w = w; }
        fitText(el);
      } else {
        w ??= DEFAULT_SIZE[e.type][0]; h ??= DEFAULT_SIZE[e.type][1];
        if (w < 0) { el.x += w; w = -w; }
        if (h < 0) { el.y += h; h = -h; }
        el.w = Math.max(1, w); el.h = Math.max(1, h);
      }
    }
    for (const key of ["color", "fill"]) {
      const v = e[key];
      if (v === undefined || v === null || v === "none") continue;
      if (COLORS.includes(v) || /^#[0-9a-f]{6}$/i.test(v)) el[key] = v;
      else problems.push(`${name}: ${key} ${JSON.stringify(v)} ignored; use ${COLORS.join(", ")} or #rrggbb`);
    }
    if (e.solid === true) el.solid = true;
    if (num(e.stroke ?? null) !== null) el.stroke = clamp(num(e.stroke), 1, 24);
    if (e.dash === true) el.dash = true;
    if (num(e.radius ?? null) > 0) el.radius = num(e.radius);
    if (typeof e.by === "string" && e.by) el.by = e.by.slice(0, 40);
    seen.add(id);
    elements.push(el);
  });
  return { elements, problems };
}

export function hash(elements) {
  let h = 5381;
  const s = JSON.stringify(elements);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** One element per line, so partial reads stay short. `mark`: the mod itself saved this. */
export function serialize(elements, mark) {
  const { elements: clean } = normalize(elements);
  const head = mark ? `{ "version": 1, "mark": "${hash(clean)}", "elements": [` : '{ "version": 1, "elements": [';
  const nl = clean.length ? "\n" : "";
  return `${head}${nl}${clean.map((e) => JSON.stringify(e)).join(",\n")}${nl}] }\n`;
}

/** board.json's text to { elements, problems, own }. Throws on broken JSON. */
export function parse(text) {
  const raw = JSON.parse(text);
  const { elements, problems } = normalize(raw);
  return { elements, problems, own: raw?.mark === hash(elements) };
}

// ---- geometry --------------------------------------------------------------

export function bounds(el) {
  if (el.type === "stroke") {
    let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of el.points) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  if (isLine(el)) return { x: Math.min(el.x, el.x2), y: Math.min(el.y, el.y2), w: Math.abs(el.x2 - el.x), h: Math.abs(el.y2 - el.y) };
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

export function boxOf(elements, title = 0) {
  if (!elements.length) return null;
  let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const el of elements) {
    const b = bounds(el);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y - (el.type === "frame" ? title : 0)); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export function hit(el, x, y, tol) {
  if (el.type === "stroke") {
    const p = el.points;
    if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= tol + 3;
    for (let i = 1; i < p.length; i++) if (segDist(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= tol) return true;
    return false;
  }
  if (isLine(el)) return segDist(x, y, el.x, el.y, el.x2, el.y2) <= tol;
  const within = x >= el.x - tol && x <= el.x + el.w + tol && y >= el.y - tol && y <= el.y + el.h + tol;
  // A frame is taken by its edge or its title, so what's inside stays reachable.
  if (el.type === "frame") {
    if (x >= el.x && x <= el.x + Math.max(80, textWidth(el.text ?? "", fontSize(el))) && y >= el.y - 26 && y < el.y) return true;
    return within && !(x > el.x + tol && x < el.x + el.w - tol && y > el.y + tol && y < el.y + el.h - tol);
  }
  return within;
}

export function shift(el, dx, dy) {
  if (el.type === "stroke") return { ...el, points: el.points.map(([x, y]) => [tenth(x + dx), tenth(y + dy)]) };
  if (isLine(el)) return { ...el, x: tenth(el.x + dx), y: tenth(el.y + dy), x2: tenth(el.x2 + dx), y2: tenth(el.y2 + dy) };
  return { ...el, x: tenth(el.x + dx), y: tenth(el.y + dy) };
}

/** `el` scaled from the box `a` to the box `b`. */
export function scale(el, a, b) {
  const X = (x) => tenth(b.x + (a.w ? ((x - a.x) / a.w) * b.w : 0));
  const Y = (y) => tenth(b.y + (a.h ? ((y - a.y) / a.h) * b.h : 0));
  if (el.type === "stroke") return { ...el, points: el.points.map(([x, y]) => [X(x), Y(y)]) };
  if (isLine(el)) return { ...el, x: X(el.x), y: Y(el.y), x2: X(el.x2), y2: Y(el.y2) };
  const out = { ...el, x: X(el.x), y: Y(el.y), w: Math.max(4, tenth(X(el.x + el.w) - X(el.x))), h: Math.max(4, tenth(Y(el.y + el.h) - Y(el.y))) };
  return el.type === "text" ? fitText({ ...out, fixed: true, w: Math.max(20, out.w) }) : out;
}

/** Ramer-Douglas-Peucker, without recursion. */
export function simplify(points, eps) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1; let best = eps;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(points[i][0], points[i][1], points[a][0], points[a][1], points[b][0], points[b][1]);
      if (d > best) { best = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return points.filter((_p, i) => keep[i]);
}

/** Rounds off the stairs a pointer that moves by cells leaves. The ends stay. */
export function soften(points) {
  if (points.length < 5) return points;
  const pass = (points) => points.map((p, i) => {
    const r = Math.min(3, i, points.length - 1 - i);
    if (!r) return p;
    let x = 0; let y = 0;
    for (let j = i - r; j <= i + r; j++) { x += points[j][0]; y += points[j][1]; }
    return [x / (2 * r + 1), y / (2 * r + 1)];
  });
  return pass(pass(points));
}

/** A line's arrowhead, as three points. */
export function arrowHead(x, y, x2, y2, len) {
  const d = Math.hypot(x2 - x, y2 - y) || 1;
  const ux = (x2 - x) / d; const uy = (y2 - y) / d;
  return [[x2, y2], [x2 - ux * len - uy * len * 0.5, y2 - uy * len + ux * len * 0.5], [x2 - ux * len + uy * len * 0.5, y2 - uy * len - ux * len * 0.5]];
}

// ---- merging and telling changes -------------------------------------------

// Key order and authorship don't make an element different.
const KEYS = ["id", "type", "x", "y", "w", "h", "x2", "y2", "points", "text", "size", "fixed", "color", "fill", "solid", "stroke", "dash", "radius"];
const same = (a, b) => a === b || JSON.stringify(a, KEYS) === JSON.stringify(b, KEYS);
const byId = (list) => new Map(list.map((e) => [e.id, e]));

/** Three-way merge by id: what I changed since `base` wins, the rest is theirs. */
export function merge(base, mine, theirs) {
  const B = byId(base); const M = byId(mine); const T = byId(theirs);
  const out = [];
  for (const t of theirs) {
    const m = M.get(t.id); const b = B.get(t.id);
    if (!m) { if (!b || !same(b, t)) out.push(t); continue; }
    out.push(b && same(b, m) ? t : m);
  }
  for (const m of mine) {
    if (T.has(m.id)) continue;
    const b = B.get(m.id);
    if (!b || !same(b, m)) out.push(m);
  }
  return out;
}

const label = (el) => `${el.type} ${el.id}${el.text ? ` "${el.text.replace(/\s+/g, " ").slice(0, 60)}"` : ""}`;
const place = (el) => {
  const n = Math.round;
  if (isLine(el)) return `(${n(el.x)},${n(el.y)})->(${n(el.x2)},${n(el.y2)})`;
  const b = bounds(el);
  return `at (${n(b.x)},${n(b.y)}) ${n(b.w)}x${n(b.h)}`;
};

/** What changed from `base` to `now`, one line each. */
export function diff(base, now) {
  const B = byId(base); const N = byId(now);
  const lines = [];
  for (const e of now) {
    const b = B.get(e.id);
    if (!b) { lines.push(`+ added ${label(e)} ${place(e)}`); continue; }
    if (same(b, e)) continue;
    const what = [];
    if ((b.text ?? "") !== (e.text ?? "")) what.push(`text "${b.text ?? ""}" -> "${e.text ?? ""}"`);
    if (place(b) !== place(e)) what.push(`${place(b)} -> ${place(e)}`);
    for (const k of ["type", "color", "fill", "solid", "size", "stroke", "dash", "radius"]) if (b[k] !== e[k]) what.push(`${k} ${b[k] ?? "none"} -> ${e[k] ?? "none"}`);
    if (what.length || e.type === "stroke") lines.push(`~ changed ${label(e)}: ${what.join("; ") || "shape"}`);
  }
  for (const b of base) if (!N.has(b.id)) lines.push(`- removed ${label(b)} ${place(b)}`);
  return lines;
}

/** The board in words, for agents that can't see pictures. Strokes are counted, not listed. */
export function describe(elements, max = 60) {
  const strokes = elements.filter((e) => e.type === "stroke");
  const rest = elements.filter((e) => e.type !== "stroke");
  const lines = rest.slice(0, max).map((e) => `${label(e)} ${place(e)}${e.color && e.color !== "ink" ? ` ${e.color}` : ""}`);
  if (rest.length > max) lines.push(`... ${rest.length - max} more`);
  if (strokes.length) {
    const b = boxOf(strokes);
    lines.push(`${strokes.length} freehand stroke${strokes.length > 1 ? "s" : ""} within (${Math.round(b.x)},${Math.round(b.y)}) ${Math.round(b.w)}x${Math.round(b.h)}: look at the picture`);
  }
  return lines;
}

/** Things an agent should fix before showing its drawing. */
export function lint(elements) {
  const out = [];
  for (const e of elements) {
    if (!e.text || !["rect", "ellipse", "note", "image"].includes(e.type)) continue;
    const need = textLines(e).length * lineHeight(fontSize(e));
    if (need > e.h + 1) out.push(`${label(e)}: its text needs about ${Math.ceil(need)}px of height, it has ${Math.round(e.h)}`);
  }
  return out;
}

// ---- editing ---------------------------------------------------------------

export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export function handlePoint(box, h) {
  return [
    h.includes("w") ? box.x : h.includes("e") ? box.x + box.w : box.x + box.w / 2,
    h.includes("n") ? box.y : h.includes("s") ? box.y + box.h : box.y + box.h / 2,
  ];
}

/** Everything a person does with the pointer and the keys. Positions are px in the canvas. */
export class Board {
  constructor(elements = []) {
    this.elements = elements;
    this.sel = new Set();
    this.tool = "pen";
    this.style = { color: "ink", fill: null, stroke: 3, size: 16 };
    this.view = { x: 60, y: 60, k: 1 };
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.dirty = false;
    this.reach = 1; // how far from a thing a press still takes it
    this.smooth = 0.6; // how much a stroke is simplified
    this.coarse = false; // the pointer moves by cells
  }

  world(p) { return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k }; }
  selected() { return this.elements.filter((e) => this.sel.has(e.id)); }

  /** What the person picked to send on its own, or null. What was just drawn is selected, not picked. */
  picked() {
    if (!this.sel.size || this.sel.size >= this.elements.length || (this.sel.size === 1 && this.sel.has(this.fresh))) return null;
    return this.selected();
  }

  remember() {
    this.undoStack.push(this.elements);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  put(next) {
    this.elements = next;
    const ids = new Set(next.map((e) => e.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.dirty = true;
  }

  /** Every lasting change goes through here: one undo step each. */
  commit(next) {
    if (next === this.elements) return;
    this.remember();
    this.put(next);
  }

  /** Someone else changed the board. Undoable too. */
  external(next, needsSave) {
    this.remember();
    this.put(next);
    this.dirty = needsSave;
  }

  undo() { if (this.undoStack.length && !this.gesture) { this.redoStack.push(this.elements); this.put(this.undoStack.pop()); } }
  redo() { if (this.redoStack.length && !this.gesture) { this.undoStack.push(this.elements); this.put(this.redoStack.pop()); } }

  make(type, rest) {
    const s = this.style;
    const el = { id: newId(new Set(this.elements.map((e) => e.id))), type, ...rest };
    if (type === "note") el.fill = s.fill ?? "yellow";
    if (type !== "frame" && s.color !== "ink") el.color = s.color;
    if (s.fill && (type === "rect" || type === "ellipse")) el.fill = s.fill;
    if (["stroke", "rect", "ellipse", "line", "arrow"].includes(type)) el.stroke = type === "stroke" ? s.stroke : Math.min(s.stroke, 8);
    if (type !== "stroke" && type !== "frame" && s.size !== 16) el.size = s.size;
    return el;
  }

  /** The element under a point. Frames come last. */
  top(p) {
    const tol = (6 * this.reach) / this.view.k;
    for (const frames of [false, true]) {
      for (let i = this.elements.length - 1; i >= 0; i--) {
        const e = this.elements[i];
        if ((e.type === "frame") === frames && hit(e, p.x, p.y, tol)) return e;
      }
    }
    return null;
  }

  handleAt(p) {
    const sel = this.selected();
    const tol = (8 * this.reach) / this.view.k;
    if (sel.length === 1 && isLine(sel[0])) {
      if (Math.hypot(p.x - sel[0].x, p.y - sel[0].y) <= tol) return "start";
      if (Math.hypot(p.x - sel[0].x2, p.y - sel[0].y2) <= tol) return "end";
      return null;
    }
    const box = boxOf(sel);
    if (!box) return null;
    return HANDLES.find((h) => { const [x, y] = handlePoint(box, h); return Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol; }) ?? null;
  }

  /** A press. Returns { edit: id } or { create: element } when the text editor should open. */
  down(at, { shift: shifted = false, clicks = 1, pan = false } = {}) {
    const p = this.world(at);
    if (pan || this.tool === "hand") { this.gesture = { kind: "pan", at, view: { ...this.view } }; return {}; }
    if (this.tool === "select") {
      this.fresh = null;
      const over = this.top(p);
      if (over && clicks === 2 && hasText(over)) { this.sel = new Set([over.id]); this.gesture = null; return { edit: over.id }; }
      const handle = !shifted && this.handleAt(p);
      if (handle) { this.gesture = { kind: "resize", handle, p, before: this.elements, box: boxOf(this.selected()) }; return {}; }
      if (!over) {
        if (!shifted) this.sel = new Set();
        this.gesture = { kind: "marquee", p, q: p, keep: new Set(this.sel) };
        return {};
      }
      if (shifted) { if (this.sel.has(over.id)) { this.sel.delete(over.id); return {}; } this.sel.add(over.id); }
      else if (!this.sel.has(over.id)) this.sel = new Set([over.id]);
      this.gesture = { kind: "move", p, before: this.elements, moving: this.withContents() };
      return {};
    }
    if (this.tool === "eraser") { this.gesture = { kind: "erase", before: this.elements, last: p }; this.erase(p); return {}; }
    if (this.tool === "pen") { this.gesture = { kind: "pen", el: this.make("stroke", { points: [[p.x, p.y]] }) }; return {}; }
    const x = Math.round(p.x); const y = Math.round(p.y);
    if (this.tool === "text") {
      const el = this.top(p);
      if (el && hasText(el) && el.type !== "frame") { this.sel = new Set([el.id]); return { edit: el.id }; }
      return { create: this.make("text", { x, y: y - 10, w: 10, h: 22, text: "" }) };
    }
    const rest = LINES.has(this.tool) ? { x, y, x2: x, y2: y } : { x, y, w: 0, h: 0 };
    this.gesture = { kind: "shape", p: { x, y }, el: this.make(this.tool, rest) };
    return {};
  }

  /** The selection, and what its frames hold. */
  withContents() {
    const ids = new Set(this.sel);
    for (const f of this.selected()) if (f.type === "frame") for (const e of this.elements) if (inside(bounds(e), f)) ids.add(e.id);
    return ids;
  }

  /** Returns whether there's anything to redraw. */
  move(at, { shift: shifted = false } = {}) {
    const g = this.gesture;
    if (!g) return false;
    const p = this.world(at);
    if (g.kind === "pan") { this.view = { ...g.view, x: g.view.x + at.x - g.at.x, y: g.view.y + at.y - g.at.y }; return true; }
    if (g.kind === "pen") {
      const [lx, ly] = g.el.points[g.el.points.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) < 1.5 / this.view.k) return false;
      g.el.points.push([p.x, p.y]);
      return true;
    }
    if (g.kind === "shape") {
      let dx = p.x - g.p.x; let dy = p.y - g.p.y;
      if (shifted && isLine(g.el)) {
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12); const d = Math.hypot(dx, dy);
        dx = Math.cos(a) * d; dy = Math.sin(a) * d;
      } else if (shifted) { const d = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * d; dy = Math.sign(dy || 1) * d; }
      const R = Math.round;
      g.el = isLine(g.el) ? { ...g.el, x2: R(g.p.x + dx), y2: R(g.p.y + dy) }
        : { ...g.el, x: R(Math.min(g.p.x, g.p.x + dx)), y: R(Math.min(g.p.y, g.p.y + dy)), w: R(Math.abs(dx)), h: R(Math.abs(dy)) };
      return true;
    }
    if (g.kind === "marquee") {
      g.q = p;
      const box = { x: Math.min(g.p.x, p.x), y: Math.min(g.p.y, p.y), w: Math.abs(p.x - g.p.x), h: Math.abs(p.y - g.p.y) };
      this.sel = new Set(g.keep);
      for (const e of this.elements) {
        const b = bounds(e);
        const touches = b.x <= box.x + box.w && b.x + b.w >= box.x && b.y <= box.y + box.h && b.y + b.h >= box.y;
        if (e.type === "frame" ? inside(b, box) : touches) this.sel.add(e.id);
      }
      return true;
    }
    if (g.kind === "move") {
      let dx = p.x - g.p.x; let dy = p.y - g.p.y;
      if (!g.moved && Math.hypot(dx, dy) * this.view.k < 3) return false;
      g.moved = true;
      if (shifted) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      dx = Math.round(dx); dy = Math.round(dy);
      this.elements = g.before.map((e) => (g.moving.has(e.id) ? shift(e, dx, dy) : e));
      return true;
    }
    if (g.kind === "resize") {
      g.moved = true;
      if (g.handle === "start" || g.handle === "end") {
        const [kx, ky] = g.handle === "start" ? ["x", "y"] : ["x2", "y2"];
        this.elements = g.before.map((e) => (this.sel.has(e.id) ? { ...e, [kx]: Math.round(p.x), [ky]: Math.round(p.y) } : e));
        return true;
      }
      const a = g.box;
      let [x1, y1, x2, y2] = [a.x, a.y, a.x + a.w, a.y + a.h];
      const dx = Math.round(p.x - g.p.x); const dy = Math.round(p.y - g.p.y);
      if (g.handle.includes("w")) x1 = Math.min(x1 + dx, x2 - 4);
      if (g.handle.includes("e")) x2 = Math.max(x2 + dx, x1 + 4);
      if (g.handle.includes("n")) y1 = Math.min(y1 + dy, y2 - 4);
      if (g.handle.includes("s")) y2 = Math.max(y2 + dy, y1 + 4);
      if (shifted && a.w && a.h && g.handle.length === 2) {
        const f = Math.max((x2 - x1) / a.w, (y2 - y1) / a.h);
        if (g.handle.includes("w")) x1 = x2 - a.w * f; else x2 = x1 + a.w * f;
        if (g.handle.includes("n")) y1 = y2 - a.h * f; else y2 = y1 + a.h * f;
      }
      const b = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      this.elements = g.before.map((e) => (this.sel.has(e.id) ? scale(e, a, b) : e));
      return true;
    }
    if (g.kind === "erase") { this.erase(p); return true; }
    return false;
  }

  erase(p) {
    const g = this.gesture;
    const steps = Math.max(1, Math.ceil((Math.hypot(p.x - g.last.x, p.y - g.last.y) * this.view.k) / 6));
    for (let i = 0; i <= steps; i++) {
      const el = this.top({ x: g.last.x + ((p.x - g.last.x) * i) / steps, y: g.last.y + ((p.y - g.last.y) * i) / steps });
      if (el) this.elements = this.elements.filter((e) => e !== el);
    }
    g.last = p;
  }

  up() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return {};
    if (g.kind === "pen") {
      const points = simplify(this.coarse ? soften(g.el.points) : g.el.points, this.smooth / this.view.k).map(([x, y]) => [tenth(x), tenth(y)]);
      this.commit([...this.elements, { ...g.el, points }]);
    } else if (g.kind === "shape") {
      let el = g.el;
      const tiny = isLine(el) ? Math.hypot(el.x2 - el.x, el.y2 - el.y) < 4 : el.w < 4 && el.h < 4;
      if (tiny && isLine(el)) return {};
      if (tiny) el = { ...el, x: g.p.x, y: g.p.y, w: DEFAULT_SIZE[el.type][0], h: DEFAULT_SIZE[el.type][1] };
      if (!isLine(el)) el = { ...el, w: Math.max(4, el.w), h: Math.max(4, el.h) };
      this.commit(el.type === "frame" ? [el, ...this.elements] : [...this.elements, el]);
      this.sel = new Set([el.id]);
      this.fresh = el.id;
      this.tool = "select";
      if (el.type === "note" || el.type === "frame") return { edit: el.id };
    } else if (g.kind === "move" || g.kind === "resize" || g.kind === "erase") {
      const after = this.elements;
      this.elements = g.before;
      if (after !== g.before && (g.moved || g.kind === "erase")) this.commit(after);
    }
    return {};
  }

  cancel() {
    const g = this.gesture;
    this.gesture = null;
    if (g?.before) this.elements = g.before;
  }

  setText(el, text) {
    text = text.replace(/\s+$/, "");
    const old = this.elements.find((e) => e.id === el.id);
    if (!old) {
      if (!text || el.type !== "text") return;
      this.commit([...this.elements, fitText({ ...el, text })]);
      this.sel = new Set([el.id]);
      this.fresh = el.id;
      this.tool = "select";
      return;
    }
    if ((old.text ?? "") === text) return;
    if (!text && old.type === "text") return this.remove(new Set([old.id]));
    const next = { ...old, text };
    if (!text) delete next.text;
    this.commit(this.elements.map((e) => (e.id === old.id ? (old.type === "text" ? fitText(next) : next) : e)));
  }

  /** The style of what comes next, and of what's selected. */
  setStyle(patch) {
    Object.assign(this.style, patch);
    if (!this.sel.size) return;
    this.commit(this.elements.map((e) => {
      if (!this.sel.has(e.id)) return e;
      const next = { ...e };
      for (const [k, v] of Object.entries(patch)) {
        if (k === "fill" && !FILLED.has(e.type)) continue;
        if (k === "stroke" && !["stroke", "rect", "ellipse", "line", "arrow"].includes(e.type)) continue;
        if (k === "size" && e.type === "stroke") continue;
        next[k] = v;
      }
      if (next.fill === null) { if (e.type === "note") next.fill = "yellow"; else delete next.fill; }
      if (next.color === "ink") delete next.color;
      return e.type === "text" && patch.size ? fitText(next) : next;
    }));
  }

  remove(ids = this.sel) { if (ids.size) this.commit(this.elements.filter((e) => !ids.has(e.id))); }

  duplicate() {
    const taken = new Set(this.elements.map((e) => e.id));
    const copies = this.selected().map((e) => { const id = newId(taken); taken.add(id); return { ...shift(e, 20, 20), id }; });
    if (!copies.length) return;
    this.commit([...this.elements, ...copies]);
    this.sel = new Set(copies.map((e) => e.id));
  }

  nudge(dx, dy) {
    if (!this.sel.size) return;
    const ids = this.withContents();
    this.commit(this.elements.map((e) => (ids.has(e.id) ? shift(e, dx, dy) : e)));
  }

  order(front) {
    if (!this.sel.size) return;
    const mine = this.selected(); const rest = this.elements.filter((e) => !this.sel.has(e.id));
    this.commit(front ? [...rest, ...mine] : [...mine, ...rest]);
  }

  zoom(at, factor) {
    const k = clamp(this.view.k * factor, 0.1, 6);
    const p = this.world(at);
    this.view = { k, x: at.x - p.x * k, y: at.y - p.y * k };
  }

  fit(width, height, what = this.elements) {
    const b = boxOf(what, 26);
    if (!b || !width || !height) { this.view = { x: 20, y: 20, k: 1 }; return; }
    const pad = Math.min(30, width * 0.03) * 2;
    const k = clamp(Math.min((width - pad) / Math.max(b.w, 1), (height - pad) / Math.max(b.h, 1)), 0.1, what === this.elements ? 1 : 2);
    this.view = { k, x: (width - b.w * k) / 2 - b.x * k, y: (height - b.h * k) / 2 - b.y * k };
  }
}
