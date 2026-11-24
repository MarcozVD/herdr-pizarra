// The board in terminal cells: what it looks like and what the mouse and the keys do.
// No terminal here: tui.js (any terminal, Herdr's) and the Claude Code pane show it.
import { Board, HANDLES, INK, PAPER, arrowHead, bounds, boxOf, fontSize, handlePoint, hasText, inkOf, isLine, lineHeight, merge, parse, serialize } from "./model.js";
import { hashText } from "./hash.js";

/** A cell in board px. Braille has 2x4 dots a cell, so a dot is 4x4 px. */
export const CELL = { w: 8, h: 16 };
const DOT = 4;
const BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
const MARK = "#2f6fde";
const QUIET = "#6e7781";

const TOOLS = [["select", "v", "Mover"], ["pen", "p", "Lápiz"], ["rect", "r", "Caja"], ["ellipse", "o", "Óvalo"], ["line", "l", "Línea"], ["arrow", "a", "Flecha"],
  ["text", "t", "Texto"], ["note", "n", "Nota"], ["image", "i", "Foto"], ["frame", "f", "Marco"], ["eraser", "e", "Borrador"], ["hand", "h", "Vista"]];
const WIDTHS = [[2, "─"], [3, "━"], [6, "█"]];
const SIZES = [14, 16, 24, 40];

export function blend(color, alpha, paper = PAPER) {
  const at = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(at(color, i) * alpha + at(paper, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

/** Words of `text` in lines of at most `width` cells. */
function wrapCells(text, width) {
  const out = [];
  for (const line of text.split("\n")) {
    let now = "";
    for (let word of line.split(" ")) {
      if ((now ? now.length + 1 : 0) + word.length <= width) { now = now ? `${now} ${word}` : word; continue; }
      if (now) out.push(now);
      while (word.length > width) { out.push(word.slice(0, width)); word = word.slice(width); }
      now = word;
    }
    out.push(now);
  }
  return out;
}

/** A sheet of cols x rows cells: dots, text and colors. */
export class Sheet {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows;
    const n = cols * rows;
    this.dots = new Uint8Array(n);
    this.ink = new Array(n).fill(null);
    this.paper = new Array(n).fill(PAPER);
    this.char = new Array(n).fill(null);
    this.bold = new Uint8Array(n);
  }

  dot(dx, dy, color) {
    const cx = dx >> 1; const cy = dy >> 2;
    if (dx < 0 || dy < 0 || cx >= this.cols || cy >= this.rows) return;
    const i = cy * this.cols + cx;
    this.dots[i] |= BITS[dy & 3][dx & 1];
    this.ink[i] = color;
    this.char[i] = null;
  }

  /** A line between two points in px, clipped to the sheet. */
  line(x0, y0, x1, y1, color, { thick = 1, dash = false, phase = 0 } = {}) {
    const W = this.cols * CELL.w; const H = this.rows * CELL.h;
    let t0 = 0; let t1 = 1;
    const dx = x1 - x0; const dy = y1 - y0;
    for (const [p, q] of [[-dx, x0 + 8], [dx, W + 8 - x0], [-dy, y0 + 8], [dy, H + 8 - y0]]) {
      if (p === 0) { if (q < 0) return; continue; }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    }
    if (t0 > t1) return;
    const ax = (x0 + dx * t0) / DOT; const ay = (y0 + dy * t0) / DOT; const bx = (x0 + dx * t1) / DOT; const by = (y0 + dy * t1) / DOT;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    for (let i = 0; i <= steps; i++) {
      if (dash && ((i + phase) % 5) > 2) continue;
      const x = Math.floor(ax + ((bx - ax) * i) / steps); const y = Math.floor(ay + ((by - ay) * i) / steps);
      for (let a = 0; a < thick; a++) for (let b = 0; b < thick; b++) this.dot(x + a, y + b, color);
    }
  }

  /** Cells whose middle `inside` accepts get a paper color. `clear` hides what was under. */
  fill(x, y, w, h, color, clear, inside = null) {
    const x0 = Math.max(0, Math.floor(x / CELL.w)); const x1 = Math.min(this.cols - 1, Math.floor((x + w) / CELL.w));
    const y0 = Math.max(0, Math.floor(y / CELL.h)); const y1 = Math.min(this.rows - 1, Math.floor((y + h) / CELL.h));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const px = (cx + 0.5) * CELL.w; const py = (cy + 0.5) * CELL.h;
        if (px < x || px > x + w || py < y || py > y + h || (inside && !inside(px, py))) continue;
        const i = cy * this.cols + cx;
        this.paper[i] = color;
        if (clear) { this.dots[i] = 0; this.char[i] = null; }
      }
    }
  }

  text(cx, cy, words, color, bold = false) {
    if (cy < 0 || cy >= this.rows) return;
    for (const c of words) {
      if (cx >= 0 && cx < this.cols) {
        const i = cy * this.cols + cx;
        if (c !== " " || this.char[i] !== null) { this.char[i] = c; this.ink[i] = color; this.bold[i] = bold ? 1 : 0; }
      }
      cx++;
    }
  }

  cell(x, y) {
    const i = y * this.cols + x;
    const c = this.char[i] ?? (this.dots[i] ? String.fromCharCode(0x2800 + this.dots[i]) : " ");
    return { c, fg: this.ink[i] ?? INK.ink, bg: this.paper[i], b: Boolean(this.char[i] && this.bold[i]) };
  }
}

/** Draws elements on a sheet through a view { x, y, k } in px. */
export function paint(sheet, elements, view) {
  const X = (v) => v * view.k + view.x; const Y = (v) => v * view.k + view.y;
  const wide = sheet.cols * CELL.w; const tall = sheet.rows * CELL.h;
  for (const el of [...elements.filter((e) => e.type === "frame"), ...elements.filter((e) => e.type !== "frame")]) {
    const b = bounds(el);
    if (X(b.x + b.w) < -20 || Y(b.y + b.h) < -20 || X(b.x) > wide + 20 || Y(b.y) > tall + 40) continue;
    const color = inkOf(el.color);
    const thick = (el.stroke ?? 2) * view.k >= 5 ? 2 : 1;
    const opts = { thick, dash: Boolean(el.dash) };
    if (el.type === "stroke") {
      const p = el.points;
      if (p.length === 1) sheet.dot(Math.floor(X(p[0][0]) / DOT), Math.floor(Y(p[0][1]) / DOT), color);
      for (let i = 1; i < p.length; i++) sheet.line(X(p[i - 1][0]), Y(p[i - 1][1]), X(p[i][0]), Y(p[i][1]), color, opts);
      continue;
    }
    if (isLine(el)) {
      const [x1, y1, x2, y2] = [X(el.x), Y(el.y), X(el.x2), Y(el.y2)];
      sheet.line(x1, y1, x2, y2, color, opts);
      if (el.type === "arrow") {
        const [tip, l, r] = arrowHead(x1, y1, x2, y2, 14);
        for (let f = 0; f <= 1.001; f += 0.25) sheet.line(tip[0], tip[1], l[0] + (r[0] - l[0]) * f, l[1] + (r[1] - l[1]) * f, color);
      }
      if (el.text) {
        const words = el.text.split("\n")[0];
        sheet.text(Math.round((x1 + x2) / 2 / CELL.w - words.length / 2), Math.floor((y1 + y2) / 2 / CELL.h) - 1, words, color);
      }
      continue;
    }
    const [x, y, w, h] = [X(el.x), Y(el.y), el.w * view.k, el.h * view.k];
    const right = x + w; const bottom = y + h;
    const fill = el.fill ? inkOf(el.fill) : null;
    const outline = (c, o) => {
      sheet.line(x, y, right, y, c, o); sheet.line(x, bottom, right, bottom, c, o);
      sheet.line(x, y, x, bottom, c, o); sheet.line(right, y, right, bottom, c, o);
    };
    const bold = fontSize(el) * view.k >= 22;
    const cx0 = Math.round(x / CELL.w); const cy0 = Math.floor(y / CELL.h);
    const middle = (c) => {
      if (!el.text || w < CELL.w * 2) return;
      const room = Math.max(1, Math.floor(w / CELL.w) - (w > CELL.w * 6 ? 2 : 0));
      const lines = wrapCells(el.text, room).slice(0, Math.max(1, Math.floor(h / CELL.h)));
      const top = Math.round((y + h / 2) / CELL.h - lines.length / 2);
      lines.forEach((l, i) => sheet.text(Math.round((x + w / 2) / CELL.w - l.length / 2), top + i, l, c, bold));
    };
    if (el.type === "text") {
      const lines = el.fixed ? wrapCells(el.text ?? "", Math.max(1, Math.floor(w / CELL.w))) : (el.text ?? "").split("\n");
      const step = Math.max(1, Math.round((lineHeight(fontSize(el)) * view.k) / CELL.h));
      lines.forEach((l, i) => sheet.text(cx0, Math.floor((y + (fontSize(el) * view.k) / 2) / CELL.h) + i * step, l, color, bold));
    } else if (el.type === "note") {
      sheet.fill(x, y, w, h, blend(fill ?? INK.yellow, 0.22), false);
      const room = Math.max(1, Math.floor(w / CELL.w) - 2);
      wrapCells(el.text ?? "", room).slice(0, Math.max(1, Math.floor(h / CELL.h))).forEach((l, i) => sheet.text(cx0 + 1, cy0 + i + (y % CELL.h > CELL.h / 2 ? 1 : 0), l, color));
    } else if (el.type === "frame") {
      outline(INK.gray, {});
      sheet.text(cx0, cy0 - 1, (el.text ?? "").slice(0, Math.max(4, Math.floor(w / CELL.w))), QUIET, true);
    } else if (el.type === "ellipse") {
      const mx = x + w / 2; const my = y + h / 2; const rx = w / 2; const ry = h / 2;
      if (fill) sheet.fill(x, y, w, h, el.solid ? fill : blend(fill, 0.18), Boolean(el.solid), (px, py) => ((px - mx) / (rx || 1)) ** 2 + ((py - my) / (ry || 1)) ** 2 <= 1);
      const n = Math.max(16, Math.min(160, Math.round((rx + ry) / 3)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI; const c = ((i + 1) / n) * 2 * Math.PI;
        sheet.line(mx + Math.cos(a) * rx, my + Math.sin(a) * ry, mx + Math.cos(c) * rx, my + Math.sin(c) * ry, color, { ...opts, phase: i * 2 });
      }
      middle(el.solid && fill ? PAPER : color);
    } else {
      if (el.type === "image") {
        sheet.fill(x, y, w, h, blend(INK.gray, 0.12), false);
        sheet.line(x, y, right, bottom, blend(color, 0.35)); sheet.line(right, y, x, bottom, blend(color, 0.35));
      } else if (fill) sheet.fill(x, y, w, h, el.solid ? fill : blend(fill, 0.18), Boolean(el.solid));
      outline(color, opts);
      middle(el.solid && fill && el.type === "rect" ? PAPER : color);
    }
  }
}

/** A line being typed. */
class Field {
  constructor(text = "") { this.text = text; this.at = text.length; }

  key(key, mods) {
    const left = this.text.slice(0, this.at); const right = this.text.slice(this.at);
    if (key === "backspace") { if (mods.ctrl || mods.meta) { const cut = left.replace(/\S*\s*$/, ""); this.text = cut + right; this.at = cut.length; } else if (left) { this.text = left.slice(0, -1) + right; this.at--; } }
    else if (key === "delete") this.text = left + right.slice(1);
    else if (key === "left") this.at = Math.max(0, this.at - 1);
    else if (key === "right") this.at = Math.min(this.text.length, this.at + 1);
    else if (key === "home") this.at = 0;
    else if (key === "end") this.at = this.text.length;
    else if (key === "tab") this.insert("\n");
    else if (key.length >= 1 && !mods.ctrl && !mods.meta && (key === "space" || [...key].length === 1 || /^[^a-z]/.test(key))) this.insert(key === "space" ? " " : key);
    else return false;
    return true;
  }

  insert(s) { this.text = this.text.slice(0, this.at) + s + this.text.slice(this.at); this.at += s.length; }
}

/**
 * The whole screen. `effect(name, data)` is how it reaches its host:
 * save { text, base }, send { ask, said, ids }, target { step }, quit, redraw.
 */
export class TermUI {
  constructor(effect, { canQuit = false, hint = "" } = {}) {
    this.effect = effect;
    this.canQuit = canQuit;
    this.hint = hint;
    this.board = new Board();
    this.board.reach = 1.6;
    this.board.smooth = 3;
    this.cols = 0; this.rows = 0;
    this.text = null; // the file's text, as last agreed
    this.pending = null; // what was asked to be saved
    this.synced = [];
    this.follow = true;
    this.flash = new Set();
    this.status = "";
    this.target = null; // "Claude Code w1:p2", when the host sends to others
    this.note = new Field();
    this.typing = null; // "note" or "text"
    this.hits = [];
    this.lastDown = { t: 0, x: -1, y: -1 };
    this.loaded = false;
  }

  // ---- the file, through the host

  /** The file's text as it is now (null: no file). Returns whether to redraw. */
  receive(text) {
    const first = !this.loaded;
    this.loaded = true;
    if (text === this.text && !first) return false;
    if (text === null) { this.text = null; return first; }
    if (this.pending && text === this.pending.text) {
      this.text = text; this.synced = this.pending.elements;
      if (this.board.elements === this.pending.elements) this.board.dirty = false;
      this.pending = null;
      this.saveIfDirty();
      return false;
    }
    if (this.board.gesture) { this.loaded = !first; return false; }
    let theirs;
    try { theirs = parse(text); } catch (e) {
      this.broken = true; this.status = `board.json no es JSON válido: ${e.message.split("\n")[0]}`;
      return true;
    }
    if (this.broken) { this.broken = false; this.status = ""; }
    const mine = this.board.elements;
    const before = new Map(mine.map((e) => [e.id, JSON.stringify(e)]));
    const changed = theirs.elements.filter((e) => before.get(e.id) !== JSON.stringify(e));
    const next = merge(this.synced, mine, theirs.elements);
    if (first && !mine.length) this.board.elements = next;
    else this.board.external(next, this.board.dirty || next.length !== theirs.elements.length);
    this.text = text; this.synced = theirs.elements; this.pending = null;
    if (!first && !theirs.own && changed.length) {
      this.flash = new Set(changed.map((e) => e.id));
      this.status = `El agente dibujó ${changed.length} elemento${changed.length === 1 ? "" : "s"} · Ctrl+Z deshace`;
    }
    if (first) this.refit(); else this.keepInView();
    this.saveIfDirty();
    return true;
  }

  saveIfDirty() {
    if (!this.board.dirty || this.broken || this.board.gesture) return;
    const elements = this.board.elements;
    const text = serialize(elements, true);
    if (text === this.text) { this.board.dirty = false; this.synced = elements; return; }
    this.pending = { text, elements };
    this.effect("save", { text, base: this.text === null ? null : hashText(this.text) });
  }

  // ---- layout

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    this.layout();
    this.keepInView();
  }

  /** Bars wrap to the width there is; the paper takes the rest. */
  layout() {
    const s = this.board.style;
    const tools = TOOLS.map(([name, key, word]) => ({ t: ` ${word} `, on: this.board.tool === name, act: () => this.pick(name), key }));
    const styles = [
      ...Object.entries(INK).map(([name, hex]) => ({ t: s.color === name ? "▐█▌" : " █ ", fg: name === "ink" ? "#c9d1d9" : hex, act: () => this.board.setStyle({ color: name }) })),
      ...WIDTHS.map(([w, c]) => ({ t: ` ${c} `, on: s.stroke === w, act: () => this.board.setStyle({ stroke: w }) })),
      { t: s.fill ? " Relleno■ " : " Relleno□ ", on: Boolean(s.fill), act: () => this.board.setStyle({ fill: s.fill ? null : s.color }) },
      { t: ` ${s.size}px `, act: () => this.board.setStyle({ size: SIZES[(SIZES.indexOf(s.size) + 1) % SIZES.length] }) },
      { t: " Deshacer ", act: () => this.board.undo() }, { t: " Rehacer ", act: () => this.board.redo() },
      { t: this.board.sel.size ? " Borrar " : " Vaciar ", act: () => (this.board.sel.size ? this.board.remove() : this.board.elements.length && this.board.commit([])) },
      { t: " − ", act: () => this.zoomBy(1 / 1.25) }, { t: ` ${Math.round(this.board.view.k * 100)}% `, act: () => this.zoomBy(1 / this.board.view.k) }, { t: " + ", act: () => this.zoomBy(1.25) }, { t: " Ver todo ", act: () => this.look() },
    ];
    const bar = [];
    for (const group of [tools, styles]) {
      let row = []; let w = 0;
      for (const item of group) {
        if (w + item.t.length > this.cols && row.length) { bar.push(row); row = []; w = 0; }
        row.push({ ...item, x: w }); w += item.t.length;
      }
      bar.push(row);
    }
    // A short panel keeps the paper: the style bar goes first, then the tools.
    const foot = this.rows < 14 ? 2 : 3;
    const most = Math.max(1, this.rows - foot - 6);
    this.bar = bar.slice(0, Math.min(bar.length, most));
    this.foot = foot;
    this.top = this.bar.length;
    this.paperRows = Math.max(1, this.rows - this.top - foot);
  }

  get paperPx() { return { width: this.cols * CELL.w, height: this.paperRows * CELL.h }; }

  refit() { this.follow = true; const { width, height } = this.paperPx; this.fitted = this.paperPx; if (this.cols) this.board.fit(width, height); }

  look() {
    if (!this.board.sel.size || !this.follow) { this.refit(); return; }
    this.follow = false;
    const { width, height } = this.paperPx;
    this.board.fit(width, height, this.board.selected());
  }

  keepInView() {
    const { elements, view: { x, y, k }, gesture } = this.board;
    if (!this.follow || gesture || this.typing === "text" || !this.loaded || !this.cols) return;
    const b = boxOf(elements);
    if (!b) return;
    const { width, height } = this.paperPx;
    const inView = b.x * k + x >= 0 && b.y * k + y >= 0 && (b.x + b.w) * k + x <= width && (b.y + b.h) * k + y <= height;
    const grew = k < 1 && (width > (this.fitted?.width ?? 0) * 1.1 || height > (this.fitted?.height ?? 0) * 1.25);
    if (!inView || grew) this.refit();
  }

  zoomBy(factor, at) {
    this.follow = false;
    const { width, height } = this.paperPx;
    this.board.zoom(at ?? { x: width / 2, y: height / 2 }, factor);
  }

  // ---- drawing

  /** Rows of runs { t, fg, bg, b, inv }; no fg or bg means the terminal's own. */
  render() {
    this.layout();
    this.hits = [];
    const out = [];
    this.bar.forEach((items, y) => {
      const runs = []; let w = 0;
      for (const it of items) {
        runs.push({ t: it.t, fg: it.fg, inv: Boolean(it.on) });
        this.hits.push({ x: it.x, y, w: it.t.length, act: it.act });
        w += it.t.length;
      }
      if (w < this.cols) runs.push({ t: " ".repeat(this.cols - w) });
      out.push(runs);
    });

    const sheet = new Sheet(this.cols, this.paperRows);
    const b = this.board;
    const typing = this.typing === "text" ? this.editing : null;
    let elements = b.elements;
    if (typing) {
      const live = { ...typing.el, text: typing.field.text };
      elements = elements.some((e) => e.id === live.id) ? elements.map((e) => (e.id === live.id ? live : e)) : [...elements, live];
    }
    if (b.gesture?.el) elements = [...elements, b.gesture.el];
    paint(sheet, elements, b.view);
    this.marks(sheet);
    if (!elements.length) {
      const lines = this.paperRows > 3 ? ["Dibuja aquí", "o pide abajo un dibujo"] : ["Dibuja aquí"];
      lines.forEach((l, i) => sheet.text(Math.max(0, Math.round((this.cols - l.length) / 2)), Math.floor(this.paperRows / 2) - 1 + i, l, INK.gray));
    }
    for (let y = 0; y < this.paperRows; y++) {
      const runs = []; let last = null;
      for (let x = 0; x < this.cols; x++) {
        const { c, fg, bg, b: bold } = sheet.cell(x, y);
        const ink = c === " " ? last?.fg ?? fg : fg;
        if (last && last.fg === ink && last.bg === bg && last.b === bold) last.t += c;
        else { last = { t: c, fg: ink, bg, b: bold }; runs.push(last); }
      }
      out.push(runs);
    }
    out.push(...this.footer(out.length));
    return out;
  }

  marks(sheet) {
    const b = this.board;
    const { x, y, k } = b.view;
    const box = (r, color) => { const [l, t, rr, bb] = [r.x * k + x, r.y * k + y, (r.x + r.w) * k + x, (r.y + r.h) * k + y]; sheet.line(l, t, rr, t, color, { dash: true }); sheet.line(l, bb, rr, bb, color, { dash: true }); sheet.line(l, t, l, bb, color, { dash: true }); sheet.line(rr, t, rr, bb, color, { dash: true }); };
    const knob = (px, py) => sheet.text(Math.floor((px * k + x) / CELL.w), Math.floor((py * k + y) / CELL.h), "■", MARK);
    for (const el of b.elements) if (this.flash.has(el.id)) { const r = bounds(el); const pad = 5 / k; box({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }, MARK); }
    const sel = b.selected();
    if (sel.length === 1 && isLine(sel[0])) { knob(sel[0].x, sel[0].y); knob(sel[0].x2, sel[0].y2); }
    else if (sel.length) { const r = boxOf(sel); box(r, MARK); for (const h of HANDLES) knob(...handlePoint(r, h)); }
    const g = b.gesture;
    if (g?.kind === "marquee") box({ x: Math.min(g.p.x, g.q.x), y: Math.min(g.p.y, g.q.y), w: Math.abs(g.q.x - g.p.x), h: Math.abs(g.q.y - g.p.y) }, MARK);
  }

  footer(y0) {
    const cut = (s, w) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w));
    const field = this.typing === "text" ? this.editing.field : this.note;
    const label = this.typing === "text" ? " Texto › " : " › ";
    const room = Math.max(1, this.cols - label.length - 1);
    const shown = field.text.replaceAll("\n", "⏎");
    const start = Math.max(0, field.at - room + 1);
    const body = shown.slice(start, start + room);
    let line;
    if (this.typing) {
      const at = field.at - start;
      line = [{ t: label, b: true }, { t: body.slice(0, at) }, { t: body[at] ?? " ", inv: true }, { t: body.slice(at + 1).padEnd(Math.max(0, room - Math.max(at + 1, body.length) + 1)) }];
    } else line = [{ t: label, b: true }, field.text ? { t: cut(shown, room + 1) } : { t: cut("Dile algo al agente (clic o /)", room + 1), fg: INK.gray }];
    this.hits.push({ x: 0, y: y0 + this.foot - 2, w: this.cols, act: () => { if (this.typing !== "text") this.typing = "note"; } });

    const picked = Boolean(this.board.picked());
    const items = this.typing === "text"
      ? [{ t: " Listo (Enter) ", inv: true, act: () => this.finishText() }]
      : [{ t: " Pedir dibujo ", act: () => this.send(true) }, { t: picked ? " Enviar selección " : " Enviar ", inv: true, act: () => this.send(false) }];
    if (this.target !== null && this.typing !== "text") items.push({ t: ` → ${this.target || "sin agentes"} `, fg: "#7aa2f7", act: () => this.effect("target", { step: 1 }) });
    if (this.canQuit) items.push({ t: " Salir ", act: () => this.effect("quit", {}) });
    const last = []; let w = 0;
    for (const it of items) {
      if (w + it.t.length > this.cols) { if (!w) last.push({ t: cut(it.t, this.cols), inv: it.inv }); break; }
      last.push({ t: it.t, inv: it.inv, fg: it.fg, b: true });
      this.hits.push({ x: w, y: y0 + this.foot - 1, w: it.t.length, act: it.act });
      w += it.t.length + 1; last.push({ t: " " });
    }
    const spare = this.cols - w;
    if (this.foot === 2 && this.status && spare > 8) last.push({ t: cut(this.status, spare), fg: INK.gray });
    else if (spare > 0) last.push({ t: " ".repeat(spare) });
    const status = [{ t: cut(` ${this.status || this.hint}`, this.cols), fg: INK.gray }];
    return this.foot === 3 ? [status, line, last] : [line, last];
  }

  // ---- mouse and keys

  /** x, y in cells, with the fraction when the terminal tells it. type: down, move, up, wheel. */
  pointer(e) {
    const at = { x: e.x * CELL.w, y: (e.y - this.top) * CELL.h };
    if (e.type === "wheel") {
      if (e.ctrl) this.zoomBy(e.dy > 0 ? 1 / 1.15 : 1.15, at);
      else { this.follow = false; const v = this.board.view; this.board.view = e.shift ? { ...v, x: v.x - e.dy * 24 } : { ...v, y: v.y - e.dy * 32 }; }
      return true;
    }
    if (e.type === "down") {
      const cx = Math.floor(e.x); const cy = Math.floor(e.y);
      const hit = this.hits.find((h) => cy === h.y && cx >= h.x && cx < h.x + h.w);
      if (hit) {
        if (this.typing === "text") this.finishText();
        hit.act(); this.saveIfDirty();
        return true;
      }
      if (cy < this.top || cy >= this.top + this.paperRows) return false;
      if (this.typing === "text") this.finishText();
      this.typing = null;
      this.flash = new Set();
      this.board.smooth = e.exact ? 0.8 : 1.5;
      this.board.coarse = !e.exact;
      const now = Date.now();
      const again = now - this.lastDown.t < 400 && this.lastDown.x === cx && this.lastDown.y === cy;
      this.lastDown = again ? { t: 0, x: -1, y: -1 } : { t: now, x: cx, y: cy };
      const r = this.board.down(at, { shift: Boolean(e.shift), clicks: again ? 2 : 1, pan: e.button === "middle" || e.button === "right" });
      if (this.board.gesture?.kind === "pan") this.follow = false;
      if (r.edit) this.startText(this.board.elements.find((x) => x.id === r.edit));
      if (r.create) this.startText(r.create);
      return true;
    }
    if (!this.board.gesture) return false;
    if (e.type === "move") return this.board.move(at, { shift: Boolean(e.shift) });
    if (e.type === "up") {
      this.board.move(at, { shift: Boolean(e.shift) });
      const r = this.board.up();
      if (r.edit) this.startText(this.board.elements.find((x) => x.id === r.edit));
      this.saveIfDirty();
      return true;
    }
    return false;
  }

  key(key, mods = {}) {
    if (this.typing) {
      const field = this.typing === "text" ? this.editing.field : this.note;
      if (key === "return") { if (this.typing === "text") this.finishText(); else this.send(false); }
      else if (key === "escape") { if (this.typing === "text") this.finishText(); else this.typing = null; }
      else if (key === "tab" && this.typing === "note") this.typing = null;
      else return field.key(key, mods);
      this.saveIfDirty();
      return true;
    }
    const b = this.board;
    const step = mods.shift ? 80 : 8;
    const plain = {
      delete: () => b.remove(), backspace: () => b.remove(),
      left: () => b.nudge(-step, 0), right: () => b.nudge(step, 0), up: () => b.nudge(0, -step), down: () => b.nudge(0, step),
      0: () => this.look(), 1: () => this.zoomBy(1 / b.view.k), "+": () => this.zoomBy(1.2), "=": () => this.zoomBy(1.2), "-": () => this.zoomBy(1 / 1.2),
      "]": () => b.order(true), "[": () => b.order(false), "/": () => { this.typing = "note"; },
      return: () => { const s = b.selected(); if (s.length === 1 && hasText(s[0])) this.startText(s[0]); else this.typing = "note"; },
      escape: () => { if (b.gesture) b.cancel(); else b.sel = new Set(); },
    };
    const ctrl = { z: () => (mods.shift ? b.redo() : b.undo()), y: () => b.redo(), d: () => b.duplicate(), a: () => { b.sel = new Set(b.elements.map((x) => x.id)); b.tool = "select"; }, q: () => this.canQuit && this.effect("quit", {}) };
    const tool = !mods.ctrl && !mods.meta && TOOLS.find(([, k]) => k === key);
    const act = mods.ctrl ? ctrl[key] : mods.meta ? null : tool ? () => this.pick(tool[0]) : plain[key];
    if (!act) return false;
    act();
    this.saveIfDirty();
    return true;
  }

  paste(text) {
    if (!this.typing) return false;
    (this.typing === "text" ? this.editing.field : this.note).insert(text.replace(/\r\n?/g, "\n"));
    return true;
  }

  pick(tool) { this.board.tool = tool; if (tool !== "select") this.board.sel = new Set(); }

  startText(el) {
    if (!el) return;
    this.editing = { el, field: new Field(el.text ?? "") };
    this.typing = "text";
  }

  finishText() {
    const ed = this.editing;
    this.editing = null; this.typing = null;
    if (ed) { this.board.setText(ed.el, ed.field.text); this.saveIfDirty(); }
  }

  send(ask) {
    const said = this.note.text.trim();
    if (this.typing === "text") this.finishText();
    if (ask && !said) { this.status = "Escribe qué quieres que dibuje"; this.typing = "note"; return; }
    if (!ask && !this.board.elements.length) { this.status = "La pizarra está vacía"; return; }
    const some = ask ? null : this.board.picked();
    this.saveIfDirty();
    this.status = "Enviando…"; this.typing = null;
    const { width, height } = this.paperPx;
    this.effect("send", { ask, said, ids: some ? some.map((e) => e.id) : null, width, height });
  }

  /** The host's answer to a send. */
  sent(ok, status) { this.status = status; if (ok) this.note = new Field(); }
}
