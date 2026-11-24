// A board as SVG, and that as PNG (resvg compiled to wasm, in vendor/).
import { readFileSync, existsSync } from "node:fs";
import { PAPER, inkOf as ink, boxOf, isLine, fontSize, lineHeight, textLines, arrowHead } from "./model.js";

const FONTS = {
  win32: ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/seguisb.ttf", "C:/Windows/Fonts/arial.ttf"],
  darwin: ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
  linux: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"],
};
const FAMILY = { win32: "Segoe UI", darwin: "Arial" };
const MAX_SIDE = 2000;

const ENTITY = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" };
const esc = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"]/g, (c) => ENTITY[c]);
const n = (v) => Math.round(v * 100) / 100;

function words(el, x, y, anchor, color, weight = 400) {
  const size = fontSize(el);
  return textLines(el).map((line, i) =>
    `<text x="${n(x)}" y="${n(y + i * lineHeight(size) + size * 1.02)}" font-size="${size}" text-anchor="${anchor}" fill="${color}" font-weight="${weight}" xml:space="preserve">${esc(line)}</text>`).join("");
}

function draw(el) {
  const color = ink(el.color);
  const width = el.stroke ?? (el.type === "stroke" ? 3 : 2);
  const dash = el.dash ? ` stroke-dasharray="${width * 3} ${width * 2.5}"` : "";
  const line = `stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash}`;
  const fill = el.fill ? `fill="${ink(el.fill)}" fill-opacity="${el.solid ? 1 : 0.16}"` : `fill="none"`;
  if (el.type === "stroke") {
    const p = el.points;
    if (p.length === 1) return `<circle cx="${p[0][0]}" cy="${p[0][1]}" r="${width / 2}" fill="${color}"/>`;
    return `<polyline points="${p.map((q) => q.join(",")).join(" ")}" fill="none" ${line}/>`;
  }
  const size = fontSize(el);
  if (isLine(el)) {
    const head = el.type === "arrow" ? `<polygon points="${arrowHead(el.x, el.y, el.x2, el.y2, 8 + width * 2).map((q) => q.map(n).join(",")).join(" ")}" fill="${color}"/>` : "";
    return `<line x1="${el.x}" y1="${el.y}" x2="${el.x2}" y2="${el.y2}" ${line}/>${head}${words(el, (el.x + el.x2) / 2, (el.y + el.y2) / 2 - lineHeight(size) - 2, "middle", color)}`;
  }
  const tall = textLines(el).length * lineHeight(size);
  const middle = (c) => words(el, el.x + el.w / 2, el.y + (el.h - tall) / 2, "middle", c);
  const label = el.solid && el.fill ? "#ffffff" : color;
  const box = `x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}"`;
  switch (el.type) {
    case "ellipse":
      return `<ellipse cx="${el.x + el.w / 2}" cy="${el.y + el.h / 2}" rx="${el.w / 2}" ry="${el.h / 2}" ${fill} ${line}/>${middle(label)}`;
    case "text":
      return words(el, el.x, el.y, "start", color);
    case "note":
      return `<rect ${box} rx="6" fill="${ink(el.fill ?? "yellow")}" fill-opacity="0.22"/>${words(el, el.x + 8, el.y + 8, "start", color)}`;
    case "image":
      return `<rect ${box} rx="${el.radius ?? 0}" fill="#8b929b" fill-opacity="0.1" stroke="${color}" stroke-width="1.5"/><path d="M${el.x} ${el.y}L${el.x + el.w} ${el.y + el.h}M${el.x + el.w} ${el.y}L${el.x} ${el.y + el.h}" stroke="${color}" stroke-opacity="0.35"/>${middle(color)}`;
    case "frame":
      return `<rect ${box} rx="4" fill="#ffffff" stroke="#8b929b" stroke-width="1.5"/>${words(el, el.x, el.y - 24, "start", "#57606a", 600)}`;
    default:
      return `<rect ${box} rx="${el.radius ?? 6}" ${fill} ${line}/>${middle(label)}`;
  }
}

export function toSvg(elements) {
  const b = boxOf(elements, 30) ?? { x: 0, y: 0, w: 200, h: 100 };
  const pad = 30;
  const w = Math.ceil(b.w + pad * 2); const h = Math.ceil(b.h + pad * 2);
  const ordered = [...elements.filter((e) => e.type === "frame"), ...elements.filter((e) => e.type !== "frame")];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${n(b.x - pad)} ${n(b.y - pad)} ${w} ${h}" font-family="sans-serif">`
    + `<rect x="${n(b.x - pad)}" y="${n(b.y - pad)}" width="${w}" height="${h}" fill="${PAPER}"/>${ordered.map(draw).join("")}</svg>`;
}

let ready;
export async function toPng(elements) {
  const { initWasm, Resvg } = await import("./vendor/resvg.mjs");
  ready ??= initWasm(readFileSync(new URL("./vendor/resvg.wasm", import.meta.url)));
  await ready;
  const svg = toSvg(elements);
  const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg).map(Number);
  // Small boards at twice their size, big ones at most MAX_SIDE, so agents can read the text.
  const zoom = Math.min(2, MAX_SIDE / Math.max(w, h));
  const fontBuffers = (FONTS[process.platform] ?? FONTS.linux).filter((f) => existsSync(f)).map((f) => readFileSync(f));
  const family = FAMILY[process.platform];
  return new Resvg(svg, {
    fitTo: { mode: "zoom", value: zoom },
    font: { fontBuffers, ...(family ? { defaultFontFamily: family, sansSerifFamily: family } : {}) },
  }).render().asPng();
}
