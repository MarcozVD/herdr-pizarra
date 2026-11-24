// Pizarra: a whiteboard the person and their agents share. One board per space, in
// <space folder>/.pizarra/board.json. model.js does the drawing logic; this file shows
// it, keeps it in step with the file and sends it to an agent.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, appHome, checking, exec, focused, hc, home, nextCommand, notify, props, readTextFile, run, settings, spaces, theme, window as appWindow, writeTextFile } from "herdr";
import { Board, HANDLES, INK, PAPER, inkOf, arrowHead, bounds, boxOf, fontSize, handlePoint, isLine, lineHeight, merge, parse, serialize, textLines } from "./model.js";
import { compose, headline } from "./message.js";

const TOOLS = [
  ["select", "v", "Seleccionar, mover y cambiar tamaño"],
  ["hand", "h", "Mover la vista (también botón central o rueda)"],
  ["pen", "p", "Lápiz"],
  ["rect", "r", "Rectángulo"],
  ["ellipse", "o", "Elipse"],
  ["line", "l", "Línea"],
  ["arrow", "a", "Flecha"],
  ["text", "t", "Texto"],
  ["note", "n", "Nota"],
  ["image", "i", "Hueco de imagen"],
  ["frame", "f", "Pantalla (marco)"],
  ["eraser", "e", "Borrador"],
];
const PALETTE = ["ink", "gray", "red", "orange", "yellow", "green", "blue", "purple"];
const WIDTHS = [2, 3, 6];
const SIZES = [14, 16, 24, 40];
const POLL_MS = 1000;
const FLASH_MS = 5000;
const STUCK_MS = 4000;

const slash = (p) => p.replaceAll("\\", "/").replace(/\/+$/, "");
const icon = (name) => `mods/pizarra/icons/${name}.svg`;
const message = (e) => String(e?.message ?? e).split("\n")[0];

// Marks over the white paper, the same in every theme.
const MARK = "#2f6fde";
const EDGE = "#d0d7de";
const QUIET = "#6e7781";

/** A color at `alpha`, on top of the alpha it already has. */
function tint(color, alpha) {
  const own = color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1;
  return `${color.slice(0, 7)}${Math.round(alpha * own * 255).toString(16).padStart(2, "0")}`;
}

function ellipsePath(builder, x, y, w, h) {
  const kx = (w / 2) * 0.5523; const ky = (h / 2) * 0.5523; const cx = x + w / 2; const cy = y + h / 2;
  return builder.move_to(x, cy)
    .cubic_bezier_to(cx, y, x, cy - ky, cx - kx, y)
    .cubic_bezier_to(x + w, cy, cx + kx, y, x + w, cy - ky)
    .cubic_bezier_to(cx, y + h, x + w, cy + ky, cx + kx, y + h)
    .cubic_bezier_to(x, cy, cx - kx, y + h, x, cy + ky)
    .close();
}

export default class Pizarra extends View {
  init(_props, cx) {
    this.board = new Board();
    this.synced = []; // what the file and this copy last agreed on
    this.seen = null; // what the agents last saw: changes are told from here
    this.text = null; // the file's text at that point
    this.size = { width: 0, height: 0 }; // the paper
    this.full = { width: 0, height: 0 }; // the whole panel
    this.follow = true; // the whole drawing stays in view until the person pans or zooms
    this.flash = new Set();
    this.status = "";
    this.handle = cx.focus_handle();
    this.space = props()?.space ?? focused()?.space ?? spaces().find((s) => s.active)?.id ?? null;
    this.dir = this.folder();
    this.note = InputState.new({ placeholder: "Dile algo al agente, o pídele un dibujo…" });
    if (checking()) return;
    this.note.on("submit", (_e, cx) => this.send(cx, false));
    cx.spawn(async () => { for (;;) if ((await nextCommand()) === "focus") this.handle.focus(); });
    this.start(cx);
    if (props()?.overlay) this.handle.focus();
    cx.timer.every(POLL_MS, (cx) => {
      // A call that never came back (the host drops them now and then) must not block the rest.
      if (this.waiting && Date.now() - this.turnAt > STUCK_MS) {
        this.lock = null; this.waiting = 0; this.round = (this.round ?? 0) + 1; this.saving = false;
        if (!this.loaded) this.start(cx); else this.saveSoon(cx);
      }
      if (!this.loaded || this.board.gesture || this.waiting || appWindow()?.visible === false) return;
      cx.spawn(async (cx) => { if (await this.load()) { this.unflashLater(cx); cx.notify(); } });
    });
  }

  start(cx) {
    cx.spawn(async (cx) => { await this.load(); this.loaded = true; if (!this.board.dirty && !this.board.gesture) this.refit(); this.saveSoon(cx); cx.notify(); });
  }

  // ---- the file

  folder() {
    if (props()?.dir) return slash(props().dir);
    const space = spaces().find((s) => s.id === this.space);
    if (space?.machine) return `${slash(home())}/.pizarra-remote/${space.id.replace(/[^\w-]/g, "_")}`;
    return `${slash(space?.folder || home())}/.pizarra`;
  }

  get file() { return `${this.dir}/board.json`; }
  get cli() { return `${slash(appHome())}/mods/pizarra/cli.js`; }

  /** One read or write of the file at a time. */
  locked(work) {
    this.waiting = (this.waiting ?? 0) + 1;
    this.turnAt = Date.now();
    const before = this.lock;
    const round = this.round;
    const turn = async () => {
      try { await before; } catch {}
      this.turnAt = Date.now();
      try { return await work(); } finally { if (round === this.round) this.waiting--; }
    };
    this.lock = turn();
    return this.lock;
  }

  load() { return this.locked(() => this.readBoard()); }

  /** Reads the file if it changed. Returns whether the view needs a redraw. */
  async readBoard() {
    try {
      const text = await readTextFile(this.file);
      if (text === this.text || this.board.gesture) return false;
      const first = this.text === null;
      if (text === null) { this.text = null; return false; }
      let theirs;
      try { theirs = parse(text); } catch (e) {
        const broken = `board.json no es JSON válido: ${message(e)}`;
        const changed = this.broken !== text;
        this.broken = text;
        this.status = broken;
        return changed;
      }
      if (this.broken) { this.broken = null; this.status = ""; }
      const mine = this.board.elements;
      const next = merge(this.synced, mine, theirs.elements);
      const before = new Map(mine.map((e) => [e.id, JSON.stringify(e)]));
      const changed = theirs.elements.filter((e) => before.get(e.id) !== JSON.stringify(e));
      if (first && !mine.length) { this.board.elements = next; } else this.board.external(next, next.length !== theirs.elements.length || this.board.dirty);
      this.text = text;
      this.synced = theirs.elements;
      if (theirs.own) { if (first) await this.readSeen(); } else {
        this.seen = theirs.elements;
        if (!first) {
          this.flash = new Set(changed.map((e) => e.id));
          const who = changed.find((e) => e.by)?.by;
          const name = agents().find((a) => a.address === who)?.program?.name ?? who ?? "Un agente";
          this.status = changed.length ? `${name} dibujó ${changed.length} elemento${changed.length === 1 ? "" : "s"} · Ctrl+Z lo deshace` : `${name} cambió la pizarra`;
          if (!mine.length) this.refit(); else this.keepInView();
        }
      }
      return true;
    } catch (e) {
      const status = `No se puede leer la pizarra: ${message(e)}`;
      const changed = status !== this.status;
      this.status = status;
      return changed;
    }
  }

  unflashLater(cx) {
    if (!this.flash.size) return;
    const mine = this.flash;
    cx.timer.after(FLASH_MS, (cx) => { if (this.flash === mine) { this.flash = new Set(); cx.notify(); } });
  }

  saveSoon(cx) {
    if (!this.board.dirty || this.saving) return;
    this.saving = true;
    cx.timer.after(300, (cx) => {
      this.saving = false;
      cx.spawn(async (cx) => { await this.save(); if (this.board.dirty && !this.broken) this.saveSoon(cx); cx.notify(); });
    });
  }

  save() { return this.locked(() => this.writeBoard()); }

  async writeBoard() {
    if (!this.board.dirty || this.broken) return;
    if (this.text === null) {
      const made = await exec("node", [this.cli, "init", "--dir", this.dir]);
      if (made.code !== 0) { this.board.dirty = false; this.status = `No se puede guardar: ${message(made.stderr)}`; return; }
    }
    // Take in what came since, so nobody's work is lost.
    await this.readBoard();
    if (this.broken) return;
    const elements = this.board.elements;
    const text = serialize(elements, true);
    try {
      await writeTextFile(this.file, text, this.text);
      this.text = text;
      this.synced = elements;
      if (this.board.elements === elements) this.board.dirty = false;
    } catch (e) {
      this.misses = (this.misses ?? 0) + 1;
      if (this.misses > 5) { this.status = `No se puede guardar: ${message(e)}`; this.board.dirty = false; this.misses = 0; }
      return;
    }
    this.misses = 0;
  }

  /** Puts the broken file aside and saves this copy over it. */
  recover(cx) {
    cx.spawn(async (cx) => {
      const old = await readTextFile(`${this.dir}/board.broken.json`).catch(() => null);
      try {
        await writeTextFile(`${this.dir}/board.broken.json`, this.broken, old);
        this.text = this.broken;
        this.broken = null; this.status = "Archivo dañado guardado en board.broken.json";
        this.board.dirty = true;
        this.saveSoon(cx);
      } catch (e) { this.status = message(e); }
      cx.notify();
    });
  }

  async readSeen() {
    try { const text = await readTextFile(`${this.dir}/seen.json`); if (text) this.seen = parse(text).elements; } catch {}
  }

  async writeSeen(elements) {
    this.seen = elements;
    try {
      const path = `${this.dir}/seen.json`;
      await writeTextFile(path, serialize(elements), await readTextFile(path));
    } catch {}
  }

  async close() { this.finishText(); await this.save(); }

  // ---- sending

  targets() {
    const local = agents().filter((a) => !a.address.includes("/"));
    const here = local.filter((a) => a.space === this.space);
    const list = this.everyone || !here.length ? [...here, ...local.filter((a) => a.space !== this.space)] : here;
    return { list, more: local.length - here.length };
  }

  target() {
    const { list } = this.targets();
    return list.find((a) => a.address === this.to) ?? list.find((a) => a.focused) ?? [...list].sort((a, b) => b.seq - a.seq)[0] ?? null;
  }

  /** Sends the board (or the selection), or asks for a drawing. */
  send(cx, ask) {
    if (this.sending) return;
    this.finishText();
    const to = this.target();
    const said = this.note.value().trim();
    if (!to) { this.status = "No hay agentes abiertos a quién enviar"; cx.notify(); return; }
    if (ask && !said) { this.status = "Escribe qué quieres que dibuje"; this.note.focus(); cx.notify(); return; }
    if (!ask && !this.board.elements.length) { this.status = "La pizarra está vacía"; cx.notify(); return; }
    this.sending = true; this.status = "Enviando…"; cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (let i = 0; i < 4 && this.board.dirty && !this.broken; i++) await this.save();
        if (this.broken) throw new Error("board.json está dañado");
        const all = this.board.elements;
        const part = ask ? null : this.board.picked();
        let png = null;
        if (all.length) {
          const args = [this.cli, "png", "--dir", this.dir, ...(part ? ["--ids", part.map((e) => e.id).join(",").slice(0, 20000)] : [])];
          const made = await exec("node", args);
          if (made.code !== 0) throw new Error(made.stderr || "no se pudo crear la imagen");
          png = made.stdout.trim();
        }
        const { wish, text } = compose({ ask, said, all, part, seen: this.seen, dir: this.dir, cli: this.cli, png, ...this.size });
        await this.writeMessage(text);
        await this.deliver(cx, to.address, headline({ ask, wish, dir: this.dir }));
        if (all.length) await this.writeSeen(all);
        this.note.set_value("");
        this.status = `Enviado a ${to.program?.name ?? "agente"} (${to.address})`;
        notify({ title: ask ? "Dibujo pedido" : "Pizarra enviada", body: `${to.program?.name ?? "Agente"} · ${to.address}`, level: "success", action: { name: "agent.focus", args: { terminal: to.address } } });
      } catch (e) { this.status = `No se envió: ${message(e)}`; }
      this.sending = false;
      cx.notify();
    });
  }

  /** The details go in a file: agents lose the Enter after a paste of several lines. */
  async writeMessage(text) {
    const made = await exec("node", [this.cli, "init", "--dir", this.dir]);
    if (made.code !== 0) throw new Error(made.stderr || "no se pudo crear la carpeta");
    const path = `${this.dir}/mensaje.md`;
    await writeTextFile(path, `${text}\n`, await readTextFile(path));
  }

  /** Types one line into the agent and makes sure it was submitted. */
  async deliver(cx, address, line) {
    // hc holds a message up to a minute while the person has a draft there.
    const sent = await exec("hc", ["send", address, line, "--json"], { timeout: 100000 });
    let out = null;
    try { out = JSON.parse(sent.stdout || sent.stderr); } catch {}
    if (sent.code !== 0 || out?.error) throw new Error(out?.error?.message ?? (sent.stderr || "hc send falló"));
    if (out?.started !== false) return;
    const look = async () => { try { return JSON.parse((await hc(["get", address, "--json"])).stdout); } catch { return null; } };
    const now = await look();
    const ran = (t) => t?.status?.state === "working" || (t?.turn ?? 0) > out.turn;
    if (ran(now)) return;
    if (now?.status?.state !== "blocked") {
      await hc(["keys", address, "enter"]);
      for (let i = 0; i < 6; i++) {
        await new Promise((done) => cx.timer.after(500, () => done()));
        if (ran(await look())) return;
      }
    }
    throw new Error(`el texto quedó en ${address} sin arrancar; revísalo allí`);
  }

  // ---- pointer, keys, text

  unit() { return Number(settings()?.zoom) || 1; }
  at(e) { const u = this.unit(); return { x: (e.local_position?.x ?? 0) / u, y: (e.local_position?.y ?? 0) / u }; }
  refit() { this.follow = true; this.fitted = this.size; this.board.fit(this.size.width, this.size.height); }

  /** After the panel or the drawing changed size: moves the view only if it has to, never under the pointer. */
  keepInView() {
    const { elements, view: { x, y, k }, gesture } = this.board;
    if (!this.follow || gesture || this.editing || !this.loaded) return;
    const b = boxOf(elements);
    if (!b) return;
    const { width, height } = this.size;
    const inView = b.x * k + x >= 0 && b.y * k + y >= 0 && (b.x + b.w) * k + x <= width && (b.y + b.h) * k + y <= height;
    const grew = k < 1 && (width > (this.fitted?.width ?? 0) * 1.1 || height > (this.fitted?.height ?? 0) * 1.25);
    if (!inView || grew) this.refit();
  }

  /** The selection up close (a screen, say), or everything. */
  look() {
    if (!this.board.sel.size || !this.follow) { this.refit(); return; }
    this.follow = false;
    this.board.fit(this.size.width, this.size.height, this.board.selected());
  }

  zoomBy(factor, at) {
    this.follow = false;
    this.board.zoom(at ?? { x: this.size.width / 2, y: this.size.height / 2 }, factor);
  }

  press(e, cx, pan) {
    this.finishText();
    this.handle.focus();
    this.tray = null;
    const r = this.board.down(this.at(e), { shift: e.modifiers.shift, clicks: e.click_count, pan });
    if (this.board.gesture?.kind === "pan") this.follow = false;
    if (r.edit) this.startText(this.board.elements.find((x) => x.id === r.edit));
    if (r.create) this.startText(r.create);
    cx.notify();
  }

  drag(e, cx) {
    if (!this.board.gesture) return;
    if (!e.pressed_button) return this.release(cx);
    if (this.board.move(this.at(e), { shift: e.modifiers.shift })) cx.notify();
  }

  release(cx) {
    if (!this.board.gesture) return;
    const r = this.board.up();
    if (r.edit) this.startText(this.board.elements.find((x) => x.id === r.edit));
    this.saveSoon(cx);
    cx.notify();
  }

  wheel(e, cx) {
    const u = this.unit();
    if (e.modifiers.control || e.modifiers.platform) this.zoomBy(Math.exp(e.delta.y / u / 240), this.at(e));
    else {
      this.follow = false;
      const dx = e.modifiers.shift && !e.delta.x ? e.delta.y : e.delta.x;
      const dy = e.modifiers.shift && !e.delta.x ? 0 : e.delta.y;
      this.board.view = { ...this.board.view, x: this.board.view.x + dx / u, y: this.board.view.y + dy / u };
    }
    cx.notify();
  }

  key(e, cx) {
    const b = this.board;
    const ctrl = e.modifiers.control || e.modifiers.platform;
    const step = e.modifiers.shift ? 10 : 1;
    const plain = {
      delete: () => b.remove(), backspace: () => b.remove(),
      left: () => b.nudge(-step, 0), right: () => b.nudge(step, 0), up: () => b.nudge(0, -step), down: () => b.nudge(0, step),
      0: () => this.look(), "+": () => this.zoomBy(1.2), "=": () => this.zoomBy(1.2), "-": () => this.zoomBy(1 / 1.2), 1: () => this.zoomBy(1 / b.view.k),
      "]": () => b.order(true), "[": () => b.order(false),
      enter: () => { const s = b.selected(); if (s.length === 1 && s[0].type !== "stroke") this.startText(s[0]); },
    };
    const withCtrl = {
      z: () => (e.modifiers.shift ? b.redo() : b.undo()), y: () => b.redo(), d: () => b.duplicate(),
      a: () => { b.sel = new Set(b.elements.map((x) => x.id)); b.tool = "select"; },
      enter: () => this.send(cx, false),
    };
    let act = null;
    if (e.key === "escape") {
      if (b.gesture) act = () => b.cancel();
      else if (b.sel.size) act = () => { b.sel = new Set(); };
      else return;
    } else if (ctrl) act = withCtrl[e.key];
    else if (!e.modifiers.alt) {
      const tool = !e.modifiers.shift && TOOLS.find(([, k]) => k === e.key);
      act = tool ? () => this.pick(tool[0]) : plain[e.key];
    }
    if (!act) return;
    act();
    cx.stop_propagation();
    this.saveSoon(cx);
    cx.notify();
  }

  pick(tool) { this.board.tool = tool; if (tool !== "select") this.board.sel = new Set(); }

  startText(el) {
    if (!el) return;
    const state = TextareaState.new({ value: el.text ?? "", placeholder: "Escribe…", rows: 3 });
    this.editing = { el, state };
    state.on("blur", (_e, cx) => { if (this.editing?.state === state) { this.finishText(); this.saveSoon(cx); cx.notify(); } });
    if (el.text) state.set_selected_range({ start: 0, end: el.text.length });
    state.focus();
  }

  finishText() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    this.board.setText(ed.el, ed.state.value());
    ed.state.release();
  }

  // ---- drawing

  paint(builder, color) { return window.paint_path(builder.build(), color).absolute().top(0).left(0).size_full(); }

  /** An element as native elements, in screen px. */
  draw(el) {
    const { x: vx, y: vy, k } = this.board.view;
    const X = (v) => v * k + vx; const Y = (v) => v * k + vy;
    const color = inkOf(el.color);
    const width = Math.max(1, (el.stroke ?? (el.type === "stroke" ? 3 : 2)) * k);
    const pen = () => { const p = PathBuilder.stroke(width); return el.dash ? p.dash_array([width * 3, width * 2.5]) : p; };
    if (el.type === "stroke") {
      const p = el.points;
      if (p.length === 1) return [div().absolute().left(X(p[0][0]) - width / 2).top(Y(p[0][1]) - width / 2).size(width).rounded(width).bg(color)];
      let path = pen().move_to(X(p[0][0]), Y(p[0][1]));
      for (let i = 1; i < p.length; i++) path = path.line_to(X(p[i][0]), Y(p[i][1]));
      return [this.paint(path, color)];
    }
    const size = fontSize(el) * k;
    const lh = lineHeight(fontSize(el)) * k;
    const hidden = this.editing?.el.id === el.id;
    const lines = hidden || size < 2 ? [] : textLines(el);
    const line = (text, c) => h_flex().h(lh).items_center().text_size(size).text_color(c).whitespace_nowrap().child(text || " ");
    if (isLine(el)) {
      const out = [this.paint(pen().move_to(X(el.x), Y(el.y)).line_to(X(el.x2), Y(el.y2)), color)];
      if (el.type === "arrow") out.push(this.paint(PathBuilder.fill().add_polygon(arrowHead(X(el.x), Y(el.y), X(el.x2), Y(el.y2), (8 + (el.stroke ?? 2) * 2) * k), true), color));
      if (lines.length) out.push(v_flex().absolute().left(X((el.x + el.x2) / 2) - 200).w(400).top(Y((el.y + el.y2) / 2) - lh - 2).items_center().child(line(lines[0], color)));
      return out;
    }
    const [x, y, w, h] = [X(el.x), Y(el.y), el.w * k, el.h * k];
    const box = () => div().absolute().left(x).top(y).w(w).h(h);
    const fill = el.fill ? inkOf(el.fill) : null;
    const centered = (c) => v_flex().absolute().left(x).top(y).w(w).h(h).items_center().justify_center().children(lines.map((l) => line(l, c)));
    const label = el.solid && fill ? PAPER : color;
    if (el.type === "text") return [v_flex().absolute().left(x).top(y).items_start().children(lines.map((l) => line(l, color)))];
    if (el.type === "note") return [box().rounded(6 * k).bg(tint(fill ?? INK.yellow, 0.22)), v_flex().absolute().left(x + 8 * k).top(y + 8 * k).items_start().children(lines.map((l) => line(l, color)))];
    if (el.type === "frame") return [box().rounded(4 * k).bg(PAPER).border(1.5).border_color(INK.gray), v_flex().absolute().left(x).top(y - lh - 3).font_semibold().children(lines.map((l) => line(l, QUIET)))];
    if (el.type === "ellipse") {
      const out = [];
      if (fill) out.push(this.paint(ellipsePath(PathBuilder.fill(), x, y, w, h), el.solid ? fill : tint(fill, 0.18)));
      out.push(this.paint(ellipsePath(pen(), x, y, w, h), color), centered(label));
      return out;
    }
    if (el.type === "image") {
      const cross = PathBuilder.stroke(1).move_to(x, y).line_to(x + w, y + h).move_to(x + w, y).line_to(x, y + h);
      return [box().rounded((el.radius ?? 0) * k).bg(tint(INK.gray, 0.1)).border(1).border_color(color), this.paint(cross, tint(color, 0.35)), centered(color)];
    }
    const rect = box().rounded((el.radius ?? 6) * k).border(width).border_color(color);
    if (el.dash) rect.border_dashed();
    if (fill) rect.bg(el.solid ? fill : tint(fill, 0.18));
    return [rect, centered(label)];
  }

  onScreen(el) {
    const { x, y, k } = this.board.view;
    const b = bounds(el);
    return (b.x + b.w) * k + x >= -40 && (b.y + b.h) * k + y >= -40 && b.x * k + x <= this.size.width + 40 && b.y * k + y <= this.size.height + 60;
  }

  outline(el, color) {
    const { x, y, k } = this.board.view;
    const b = bounds(el);
    return div().absolute().left(b.x * k + x - 4).top(b.y * k + y - 4).w(b.w * k + 8).h(b.h * k + 8).rounded(5).border(1).border_color(color);
  }

  marks() {
    const b = this.board;
    const { x, y, k } = b.view;
    const out = [];
    const knob = (px, py) => div().absolute().left(px - 4).top(py - 4).size(8).rounded(2).bg(PAPER).border(1).border_color(MARK);
    for (const el of b.elements) if (this.flash.has(el.id) && this.onScreen(el)) out.push(this.outline(el, MARK).loop("opacity", { from: 0.25, to: 1, period: 900 }));
    const sel = b.selected();
    if (sel.length && !this.editing) {
      if (sel.length === 1 && isLine(sel[0])) out.push(knob(sel[0].x * k + x, sel[0].y * k + y), knob(sel[0].x2 * k + x, sel[0].y2 * k + y));
      else {
        if (sel.length > 1) for (const el of sel.slice(0, 200)) out.push(this.outline(el, tint(MARK, 0.4)));
        const box = boxOf(sel);
        out.push(div().absolute().left(box.x * k + x).top(box.y * k + y).w(box.w * k).h(box.h * k).border(1).border_color(MARK));
        for (const h of HANDLES) { const [hx, hy] = handlePoint(box, h); out.push(knob(hx * k + x, hy * k + y)); }
      }
    }
    const g = b.gesture;
    if (g?.kind === "marquee") {
      out.push(div().absolute().left(Math.min(g.p.x, g.q.x) * k + x).top(Math.min(g.p.y, g.q.y) * k + y).w(Math.abs(g.q.x - g.p.x) * k).h(Math.abs(g.q.y - g.p.y) * k)
        .border(1).border_color(MARK).bg(tint(MARK, 0.1)));
    }
    return out;
  }

  editor(t) {
    const { el, state } = this.editing;
    const { x, y, k } = this.board.view;
    const b = bounds(el);
    const w = Math.min(this.size.width - 8, Math.max(180, Math.min(420, b.w * k)));
    const h = Math.max(64, Math.min(220, b.h * k));
    const left = Math.max(4, Math.min(this.size.width - w - 4, isLine(el) ? (b.x + b.w / 2) * k + x - w / 2 : b.x * k + x));
    const top = Math.max(4, Math.min(this.size.height - h - 4, el.type === "frame" ? b.y * k + y - h - 4 : b.y * k + y));
    return div().id("pz-editor").absolute().left(left).top(top).w(w).h(h)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => {
        const done = e.key === "escape" || (e.key === "enter" && (e.modifiers.control || e.modifiers.platform));
        if (!done) return;
        this.finishText(); this.handle.focus(); this.saveSoon(cx);
        cx.stop_propagation(); cx.notify();
      })
      .child(Textarea.new(state).size_full().p(8).rounded(6).border(1).border_color(t.accent).bg(t.popover).text_size(14).text_color(t.foreground));
  }

  canvas(t, tray) {
    const b = this.board;
    const g = b.gesture;
    const ordered = [...b.elements.filter((e) => e.type === "frame"), ...b.elements.filter((e) => e.type !== "frame")];
    const shown = ordered.filter((e) => this.onScreen(e));
    if (g?.el) shown.push(g.el);
    let surface = div().id("pz-canvas").absolute().top(0).left(0).size_full().overflow_hidden().bg(PAPER)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (e, cx) => this.press(e, cx, false))
      .on_mouse_down("middle", (e, cx) => this.press(e, cx, true))
      .on_mouse_down("right", (e, cx) => this.press(e, cx, true))
      .on_window_mouse_move((e, cx) => this.drag(e, cx))
      .on_window_mouse_up("left", (_e, cx) => this.release(cx))
      .on_window_mouse_up("middle", (_e, cx) => this.release(cx))
      .on_window_mouse_up("right", (_e, cx) => this.release(cx))
      .on_pinch((e, cx) => { this.zoomBy(1 + e.delta, this.at(e)); cx.notify(); })
      .on_scroll_wheel((e, cx) => this.wheel(e, cx));
    surface = b.tool === "select" ? surface.cursor_default() : b.tool === "hand" ? surface.cursor_grab() : b.tool === "text" ? surface.cursor_text() : surface.cursor_crosshair();
    surface = surface.children(shown.flatMap((e) => this.draw(e))).children(this.marks());
    if (!b.elements.length && !g && !this.editing) {
      surface = surface.child(v_flex().absolute().top(0).left(0).size_full().p(20).items_center().justify_center().gap(6).text_center().text_color(INK.gray).text_size(12.5)
        .child(div().text_size(15).text_color(QUIET).child("Dibuja aquí"))
        .child("o pide abajo un dibujo: el agente lo hace y tú lo corriges"));
    }
    return div().id("pz-wrap").relative().flex_1().min_h(0).w_full().overflow_hidden().bg(PAPER)
      .on_size_change((s, cx) => {
        const u = this.unit();
        this.size = { width: s.width / u, height: s.height / u };
        this.keepInView();
        cx.notify();
      })
      .child(surface)
      .child(this.zoomer())
      .when(Boolean(tray), (el) => el.child(tray))
      .when(Boolean(this.editing), (el) => el.child(this.editor(t)));
  }

  /** Zoom and fit, floating on the paper so they cost the bars no room. */
  zoomer() {
    const item = (id, inner, tip, act) => h_flex().id(id).h(24).min_w(24).px(4).items_center().justify_center().rounded(5).cursor_pointer().text_size(11).text_color(QUIET).tooltip(tip)
      .hover((s) => s.bg("#f0f2f4")).on_click((_e, cx) => { act(); this.handle.focus(); cx.notify(); }).child(inner);
    return h_flex().id("pz-zoom").absolute().right(8).bottom(8).p(2).rounded(7).bg(PAPER).border(1).border_color(EDGE)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(item("pz-out", "−", "Alejar (-)", () => this.zoomBy(1 / 1.25)))
      .when(this.size.width >= 260, (el) => el.child(item("pz-100", `${Math.round(this.board.view.k * 100)}%`, "Tamaño real (1)", () => this.zoomBy(1 / this.board.view.k))))
      .child(item("pz-in", "+", "Acercar (+)", () => this.zoomBy(1.25)))
      .child(item("pz-fit", svg(icon("fit")).size(13).text_color(QUIET), this.board.sel.size && this.follow ? "Acercar lo seleccionado (0)" : "Ver todo (0)", () => this.look()));
  }

  // ---- bars: the same parts, folded by the room there is

  /** How much room the panel has. It opens beside a terminal, below one, or zoomed. */
  room() {
    const { width, height } = this.full;
    const w = width || 800; const h = height || 800;
    return { w, h, wide: w >= 940, narrow: w < 560, tiny: w < 330, short: h < 440 };
  }

  bar(t) {
    const b = this.board;
    const s = b.style;
    const r = this.room();
    const button = (id, inner, tip, on, act) => h_flex().id(id).size(28).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => { this.finishText(); act(cx); this.handle.focus(); this.saveSoon(cx); cx.notify(); }).child(inner);
    const glyph = (name, on) => svg(icon(name)).size(16).text_color(on ? t.foreground : t.muted);
    const sep = () => div().w(1).h(18).mx(4).flex_none().bg(t.border);
    const open = (name) => () => { this.tray = this.tray === name ? null : name; };

    const tool = ([name, key, tip]) => button(`pz-t-${name}`, glyph(name, b.tool === name), `${tip} (${key.toUpperCase()})`, b.tool === name, () => { this.pick(name); this.tray = null; });
    const first = r.tiny ? ["select", "pen", "rect", "text", "eraser"] : ["select", "pen", "rect", "arrow", "text", "note", "eraser"];
    const main = r.narrow ? TOOLS.filter(([n]) => first.includes(n)) : TOOLS;
    const rest = TOOLS.filter((x) => !main.includes(x));
    const hiddenTool = rest.find(([n]) => n === b.tool);

    const swatch = (c, size) => div().size(size).rounded(size).bg(INK[c]).border(1).border_color(c === "ink" ? t.muted : INK[c]);
    const styles = () => [
      ...PALETTE.map((c) => button(`pz-c-${c}`, swatch(c, 14), `Color ${c}`, s.color === c, () => b.setStyle({ color: c }))),
      sep(),
      ...WIDTHS.map((w) => button(`pz-w-${w}`, div().w(14).h(w).rounded(w).bg(t.foreground), `Grosor ${w}`, s.stroke === w, () => b.setStyle({ stroke: w }))),
      button("pz-fill", div().size(14).rounded(3).border(1).border_color(t.foreground).when(Boolean(s.fill), (el) => el.bg(inkOf(s.fill))), "Relleno con el color actual", Boolean(s.fill), () => b.setStyle({ fill: s.fill ? null : s.color })),
      button("pz-size", div().text_size(11).text_color(t.muted).child(`${s.size}`), "Tamaño del texto", false, () => b.setStyle({ size: SIZES[(SIZES.indexOf(s.size) + 1) % SIZES.length] })),
    ];
    const undo = () => button("pz-undo", glyph("undo"), "Deshacer (Ctrl+Z)", false, () => b.undo());
    const redo = () => button("pz-redo", glyph("redo"), "Rehacer (Ctrl+Y)", false, () => b.redo());
    const trash = () => button("pz-trash", glyph("trash"), b.sel.size ? "Borrar lo seleccionado (Supr)" : "Vaciar la pizarra (se puede deshacer)", false, () => { this.tray = null; if (b.sel.size) b.remove(); else if (b.elements.length) b.commit([]); });
    const row = () => h_flex().w_full().min_w(0).flex_wrap().items_center().gap(2);

    const top = row().children(main.map(tool))
      .when(rest.length > 0, (el) => el.child(button("pz-more", glyph(hiddenTool ? hiddenTool[0] : "more", Boolean(hiddenTool)), "Más herramientas", Boolean(hiddenTool) || this.tray === "tools", open("tools"))))
      .child(r.narrow ? div().flex_1() : sep());
    if (r.wide) top.children(styles()).child(sep());
    else top.child(button("pz-style", swatch(s.color, 16), "Color, grosor, relleno y texto", this.tray === "style", open("style")));
    top.child(undo()).when(!r.narrow, (el) => el.child(redo()).child(trash()));
    const bar = h_flex().flex_none().w_full().px(8).py(6).bg(t.chrome).border_b(1).border_color(t.border).child(top);
    const more = this.tray === "tools" && rest.length > 0 ? row().children(rest.map(tool)).child(div().flex_1()).child(redo()).child(trash())
      : this.tray === "style" && !r.wide ? row().children(styles()) : null;
    // Over the paper, so opening or closing it never moves the paper under the pointer.
    const tray = more && div().id("pz-tray").absolute().top(0).left(0).w_full().px(8).py(6).bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(more);
    return { bar, tray };
  }

  footer(t) {
    const r = this.room();
    const { list, more } = this.targets();
    const to = this.target();
    const name = (a) => a.pane_name || a.program?.name || a.app || "agente";
    const chip = (a, opens) => {
      const on = a.address === to?.address;
      const p = a.program;
      return h_flex().id(`pz-a-${opens ? "to" : a.address}`).h(26).px(8).gap(6).min_w(0).items_center().rounded(6).border(1).cursor_pointer().text_size(12)
        .border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .tooltip(`${a.title || name(a)} · ${a.space_name} · ${a.status}`)
        .on_click((_e, cx) => { if (opens) this.choosing = !this.choosing; else { this.to = a.address; this.choosing = false; } cx.notify(); })
        .child(div().size(7).flex_none().rounded(4).bg(t[a.status] ?? t.dim))
        .when(Boolean(p?.icon && p.tint), (el) => el.child(svg(p.icon).size(13).flex_none().text_color(on ? t.foreground : t.muted)))
        .child(div().min_w(0).truncate().child(name(a))).child(div().flex_none().text_color(t.dim).child(a.address + (opens ? " ▾" : "")));
    };
    const others = () => h_flex().id("pz-more-agents").h(26).px(8).flex_none().items_center().rounded(6).cursor_pointer().text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.everyone = !this.everyone; cx.notify(); }).child(this.everyone ? "solo este espacio" : `+${more} en otros espacios`);
    const canMore = more > 0 && list.length !== more;
    const choices = (el) => el.children(list.slice(0, 16).map((a) => chip(a, false))).when(canMore, (x) => x.child(others()));
    const inline = r.wide && !r.short && list.length <= 5;

    const action = (id, text, primary, act, tip) => h_flex().id(id).h(32).px(12).items_center().justify_center().rounded(7).border(1).cursor_pointer().text_size(12.5).font_medium().whitespace_nowrap().tooltip(tip)
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(r.narrow && !r.short, (el) => el.flex_1()).when(!(r.narrow && !r.short), (el) => el.flex_none())
      .when(Boolean(this.sending), (el) => el.opacity(0.5)).hover((s) => s.opacity(0.85)).on_click((_e, cx) => act(cx)).child(text);
    const picked = Boolean(this.board.picked());
    const ask = () => action("pz-ask", r.narrow && r.short ? "Pedir" : "Pedir dibujo", false, (cx) => this.send(cx, true), "El agente dibuja en la pizarra lo que escribiste; luego lo modificas tú");
    const send = () => action("pz-send", picked && !(r.narrow && r.short) ? "Enviar selección" : "Enviar", true, (cx) => this.send(cx, false), "Envía la imagen, la escena y tus cambios (Enter)");
    const input = () => Input.new(this.note).flex_1().min_w(0).h(32).px(10).rounded(7).border(1).border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
    const recover = () => h_flex().id("pz-recover").px(8).h(24).flex_none().items_center().rounded(6).border(1).border_color(t.ansi1).text_size(12).text_color(t.ansi1).cursor_pointer()
      .on_click((_e, cx) => this.recover(cx)).child("Recuperar la mía");
    const nobody = () => div().text_size(12).text_color(t.dim).child("ningún agente abierto");
    const target = () => (to ? chip(to, true) : nobody());
    const said = () => div().flex_1().min_w(0).text_size(11.5).text_color(t.muted).truncate().child(this.status);

    const box = v_flex().flex_none().w_full().gap(6).px(8).py(r.short ? 6 : 8).bg(t.chrome).border_t(1).border_color(t.border);
    if (this.choosing && !inline && list.length) box.child(choices(h_flex().w_full().min_w(0).flex_wrap().gap(6).items_center()));
    if (inline) box.child(choices(h_flex().w_full().min_w(0).gap(6).items_center()).when(!list.length, (el) => el.child(nobody())).child(said()).when(Boolean(this.broken), (el) => el.child(recover())));
    else if (!r.short || r.narrow) {
      box.child(h_flex().w_full().min_w(0).gap(8).items_center().child(target()).child(said()).when(Boolean(this.broken), (el) => el.child(recover())));
    }
    if (r.short && !r.narrow) {
      return box.child(h_flex().w_full().min_w(0).gap(6).items_center().child(target()).when(Boolean(this.broken), (el) => el.child(recover())).child(input()).child(ask()).child(send()))
        .when(Boolean(this.status), (el) => el.child(h_flex().w_full().min_w(0).child(said())));
    }
    if (r.narrow && !r.short) return box.child(h_flex().w_full().min_w(0).child(input())).child(h_flex().w_full().min_w(0).gap(6).child(ask()).child(send()));
    return box.child(h_flex().w_full().min_w(0).gap(6).items_center().child(input()).child(ask()).child(send()));
  }

  render() {
    const t = theme();
    const { bar, tray } = this.bar(t);
    return v_flex().id("pizarra").size_full().min_h(0).min_w(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(13)
      .on_size_change((z, cx) => { const u = this.unit(); this.full = { width: z.width / u, height: z.height / u }; cx.notify(); })
      .child(bar).child(this.canvas(t, tray)).child(this.footer(t));
  }
}
