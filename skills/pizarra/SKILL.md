---
name: pizarra
description: Draw on the whiteboard (pizarra) the person shares with their agents. Use when a message starts with [Pizarra], or when the person asks to draw, sketch, wireframe or show a layout, flow or diagram "en la pizarra" / on the board, or to see what will be built before building it.
---

# Pizarra

The person sees the board live beside the terminal, changes it by hand and sends it back.

The commands are in `cli.js`. Use the path and the `--dir` the message names. Without a message, use the first of these that exists: `${CLAUDE_PLUGIN_ROOT}/mods/pizarra/cli.js`, `~/.config/herdr-app/mods/pizarra/cli.js`.

1. `node <cli.js> guide` prints the commands and the JSON format.
2. `show` first, so you build on what's there.
3. Write the elements to a temporary JSON file and `apply` it. Fix every line that starts with `!`.
4. `png`, then look at the picture and fix what overlaps or doesn't fit.
5. Say in a line or two what you drew and what you need decided. Don't build it until they answer.

A message starting with `[Pizarra]` is the person's board: read the `mensaje.md` it names, if it names one, open its image, read the list of changes since your last drawing (by element id), and treat the drawing as the spec for layout, not for exact colors or pixel sizes.
