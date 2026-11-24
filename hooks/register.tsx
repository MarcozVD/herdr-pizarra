// Pizarra in Claude Code: /pizarron opens the board in a pane beside the chat.
// panel.js draws it and takes the mouse; this file keeps board.json and sends prompts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { compose } from '../mods/pizarra/message.js'
import { parse, serialize } from '../mods/pizarra/model.js'
import { hashText } from '../mods/pizarra/hash.js'
import type { Post, Shown } from '../types'

const PANE = 'pizarra'
const POLL_MS = 1000
// A Client's props and posts hold 100,000 characters; leave room for the rest of them.
const MOST = 90_000

const shown = atom({ plugin: 'pizarra', key: 'shown' } as const, null as Shown | null, { shape: 'shown-1' })
const isOpen = atom({ plugin: 'pizarra', key: 'isOpen' } as const, false, { shape: 'open-1' })

type Elements = ReturnType<typeof parse>['elements']

let dir = ''
let cli = ''
let seen: Elements | null = null
let lastText: string | null | undefined
let lastPost = 0

async function readText($: EngineInterface, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : null
}

async function show($: EngineInterface, patch: Partial<Shown>) {
  await update($, shown, now => ({ text: null, loaded: false, answer: 0, isSent: false, status: '', tooBig: false, ...now, ...patch }))
}

async function find($: EngineInterface) {
  if (dir) return
  cli = `${$.plugin.root.replaceAll('\\', '/')}/mods/pizarra/cli.js`
  const found = await $.process.run(['node', cli, 'dir'])
  if (found.exitCode !== 0) throw new Error(found.stderr.split('\n')[0] || 'Pizarra needs Node 20 or newer on PATH')
  dir = found.stdout.trim()
}

/** Takes in board.json if it changed. */
async function look($: EngineInterface) {
  await find($)
  const text = await readText($, `${dir}/board.json`)
  if (text === lastText) return
  const isFirst = lastText === undefined
  lastText = text
  if (text !== null) {
    try {
      const board = parse(text)
      if (!board.own) seen = board.elements
      else if (isFirst) {
        const told = await readText($, `${dir}/seen.json`)
        if (told !== null) seen = parse(told).elements
      }
    } catch {
      // The panel says what's wrong with it.
    }
  }
  const tooBig = text !== null && text.length > MOST
  await show($, { text: tooBig ? null : text, loaded: true, tooBig })
}

async function save($: EngineInterface, text: string, base: string | null) {
  const now = await readText($, `${dir}/board.json`)
  if ((now === null ? null : hashText(now)) !== base) return
  if (now === null && !(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, '*\n')
  await $.fs.write(`${dir}/board.json`, text)
  lastText = text
  await show($, { text, loaded: true })
}

async function send($: EngineInterface, post: NonNullable<Post['send']>) {
  try {
    const text = await readText($, `${dir}/board.json`)
    const all: Elements = text === null ? [] : parse(text).elements
    const ids = post.ids
    const part = ids ? all.filter((e: { id: string }) => ids.includes(e.id)) : null
    let png: string | null = null
    if (all.length > 0) {
      const made = await $.process.run(['node', cli, 'png', '--dir', dir, ...(ids ? ['--ids', ids.join(',').slice(0, 20000)] : [])])
      if (made.exitCode !== 0) throw new Error(made.stderr.split('\n')[0])
      png = made.stdout.trim()
    }
    const message = compose({ ask: post.ask, said: post.said, all, part, seen, dir, cli, png, width: post.width, height: post.height })
    void $.prompt.submit({ text: `[Pizarra] ${message.text}`, asUser: true })
    if (all.length > 0) {
      seen = all
      await $.fs.write(`${dir}/seen.json`, serialize(all))
    }
    await show($, { answer: post.id, isSent: true, status: 'Enviado a Claude' })
  } catch (error) {
    await show($, { answer: post.id, isSent: false, status: `No se envió: ${error instanceof Error ? error.message : String(error)}` })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'pizarron', description: 'Abre la pizarra al lado del chat para dibujar y enviar a Claude' })
    $.clock.every(POLL_MS, async () => {
      if (await read($, isOpen)) await look($).catch(() => {})
    })
    return started
  })

  on('command.run', { command: 'pizarron' }, async $ => {
    lastText = undefined
    try {
      await look($)
    } catch (error) {
      return { text: `No se pudo abrir la pizarra: ${error instanceof Error ? error.message : String(error)}` }
    }
    await update($, isOpen, () => true)
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Pizarra', focus: true })
    return { text: isPlaced ? `Pizarra abierta: ${dir}` : 'La pizarra espera espacio: ensancha la terminal' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await read($, shown)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>La pizarra se dibuja en la terminal o en la app de escritorio.</Text>
    }
    const { Box, Client, Text } = $.ui.resolve(e)
    if (now?.tooBig) return <Text>La pizarra es muy grande para este panel: ábrela en Herdr, o borra trazos.</Text>
    const columns = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(8, e.props.scroll.bodyRows)
    return (
      <Box width={columns} height={rows}>
        <Client key="board" module="./panel.js" width={columns} height={rows} props={{ ...now }} />
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    if (e.element !== 'board') return next(e)
    const post = e.data as Post
    if (!dir) await look($)
    if (post.save) await save($, post.save.text, post.save.base)
    if (post.send && post.send.id > lastPost) {
      lastPost = post.send.id
      await send($, post.send)
    }
    lastPost = Math.max(lastPost, post.send?.id ?? 0)
    // Where the file moved on meanwhile, the panel merges it and posts again.
    await look($)
    const now = await read($, shown)
    return { props: { ...now } }
  })
}
