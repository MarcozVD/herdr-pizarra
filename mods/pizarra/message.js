// What an agent is told about the board, the same from every host.
import { describe, diff } from "./model.js";

/** { wish, text }: what the person asked, and the whole message. `png` is the picture's path, or null. */
export function compose({ ask, said, all, part, seen, dir, cli, png, width, height }) {
  const wish = said || "Mira mi boceto y dime qué entiendes antes de implementarlo.";
  const lines = [ask ? `Dibújame esto en la pizarra, sin implementarlo todavía: ${said}` : wish];
  lines.push(`Mi panel mide ${Math.round(width)}x${Math.round(height)} px: ${width < height ? "apila las pantallas en vertical" : "pon las pantallas una al lado de otra"}.`);
  if (all.length) {
    if (png) lines.push(`Imagen: ${png}`);
    lines.push(`Escena: ${dir}/board.json`);
    if (part) lines.push(`Solo te envío lo seleccionado (${part.length} de ${all.length} elementos).`);
    const changes = seen ? diff(seen, all) : [];
    if (changes.length) lines.push("Cambios desde lo último que viste:", ...changes.slice(0, 40), ...(changes.length > 40 ? [`... ${changes.length - 40} más`] : []));
    if (!seen || part) lines.push("Contenido:", ...describe(part ?? all, 40));
  }
  lines.push(`Para ver o dibujar en la pizarra: node "${cli}" guide (usa --dir "${dir}")`);
  return { wish, text: lines.join("\n") };
}

/** One line for an agent's prompt: pastes of several lines can lose their Enter. The rest goes in mensaje.md. */
export function headline({ ask, wish, dir }) {
  const flat = wish.replace(/\s+/g, " ");
  const short = flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
  return `[Pizarra] ${ask ? "Dibújame (sin implementar todavía): " : ""}${short} · Detalle: lee ${dir}/mensaje.md`;
}
