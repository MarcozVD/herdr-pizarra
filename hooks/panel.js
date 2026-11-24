// The board inside Claude Code's pane: term.js's screen, as the pane's elements.
import { TermUI } from '../mods/pizarra/term.js'

const panels = new WeakMap()

// The bars bring their own colors: a pane's background is the person's theme's, and any gray may vanish on it.
const BAR = { ink: '#e6edf3', paper: '#1f2328' }
function paint(r) {
  const ink = r.fg ?? BAR.ink
  const paper = r.bg ?? BAR.paper
  return { color: r.inv ? paper : ink, backgroundColor: r.inv ? ink : paper, ...(r.b ? { bold: true } : {}) }
}

function start(surface) {
  const panel = { waiting: {}, answer: 0 }
  // One post goes out a frame and a later one takes its place, so each carries all that's still due.
  const post = () => surface.post(JSON.parse(JSON.stringify(panel.waiting)))
  panel.ui = new TermUI((name, data) => {
    if (name === 'save') {
      panel.waiting.save = data
      post()
    } else if (name === 'send') {
      panel.waiting.send = { ...data, id: Date.now() }
      post()
    }
  }, { hint: 'Clic para escribir o dibujar · Esc vuelve al chat' })
  panel.redraw = () => surface.setState({})
  surface.onPointer(e => {
    if (e.type === 'enter' || e.type === 'leave') return
    const at = e.fine ? { x: e.fine.x, y: e.fine.y, exact: true } : { x: e.x + 0.5, y: e.y + 0.5, exact: false }
    if (panel.ui.pointer({ ...at, type: e.type, button: e.button, shift: e.shift, ctrl: e.ctrl })) panel.redraw()
  })
  surface.onKey(e => {
    if (panel.ui.key(e.key, { shift: Boolean(e.shift), ctrl: Boolean(e.ctrl), meta: Boolean(e.meta) })) panel.redraw()
  })
  surface.every(5000, () => {
    if (panel.ui.flash.size === 0) return
    panel.ui.flash = new Set()
    panel.redraw()
  })
  return panel
}

/** Claude Code's props are the file's text and the answer to the last send. */
function take(panel, props) {
  const { ui } = panel
  if (props.loaded && props.text !== panel.text) {
    panel.text = props.text
    if (panel.waiting.save && props.text === panel.waiting.save.text) delete panel.waiting.save
    ui.receive(props.text)
  }
  if (props.answer && props.answer !== panel.answer) {
    panel.answer = props.answer
    if (panel.waiting.send && panel.waiting.send.id <= props.answer) delete panel.waiting.send
    ui.sent(props.isSent, props.status)
  }
}

export default function Panel(props, surface) {
  let panel = panels.get(surface)
  if (!panel) {
    panel = start(surface)
    panels.set(surface, panel)
  }
  const { Box, Text } = surface.elements
  if (!surface.columns || !surface.rows) return h(Text, null, ' ')
  panel.ui.resize(surface.columns, surface.rows)
  take(panel, props ?? {})
  return h(
    Box,
    { flexDirection: 'column' },
    ...panel.ui.render().map(runs =>
      h(
        Text,
        { wrap: 'truncate' },
        ...runs.map(r => h(Text, paint(r), r.t)),
      ),
    ),
  )
}
