import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pizarra',
  component: 'Pane',
  requestId: 'pizarra',
  props: {
    title: 'Pizarra',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BOARD = '/w/.pizarra/board.json'

// Windows spells them C:\\w\\...
const plain = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

test('drawing saves, an agent drawing shows, and send reaches Claude', async ($, on) => {
  const files = new Map<string, string>()
  const prompts: string[] = []
  on('command.register', () => ({ value: { command: 'pizarron' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: files.has(plain(e.path)) }))
  on('fs.read', (_, e) => ({ value: files.get(plain(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(plain(e.path), e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[2] === 'dir' ? '/w/.pizarra\n' : '/w/.pizarra/board.png\n', stderr: '' } }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'pizarron' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 60, rows: 30 })
  const screen = async () => (await ui.findAll({ type: 'Text', in: 'board' })).map(t => t.text).join('\n')
  expect(await screen()).toContain('Dibuja aquí')

  await ui.pointer({ type: 'down', x: 10, y: 12, button: 'left' })
  await ui.pointer({ type: 'move', x: 20, y: 15, button: 'left' })
  await ui.pointer({ type: 'up', x: 20, y: 15, button: 'left' })
  await ui.advance(50)
  expect(files.get(BOARD) ?? '').toContain('"stroke"')
  expect(files.get('/w/.pizarra/.gitignore')).toBe('*\n')

  const now = JSON.parse(files.get(BOARD) ?? '')
  files.set(BOARD, JSON.stringify({ elements: [...now.elements, { id: 'a', type: 'rect', x: 10, y: 10, w: 160, h: 64, text: 'Hola' }] }))
  await clock.advance(1500)
  await ui.advance(50)
  expect(await screen()).toContain('Hola')

  await ui.key({ key: '/' })
  for (const key of 'haz un login') await ui.key({ key })
  await ui.key({ key: 'return' })
  await ui.advance(50)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('[Pizarra] haz un login')
  expect(prompts[0]).toContain('/w/.pizarra/board.png')
  expect(await screen()).toContain('Enviado a Claude')
  await ui.unmount()
})

test('it says where it can be drawn elsewhere', async ($, on) => {
  on('state.get', () => ({ value: { value: null, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('terminal')
  await ui.unmount()
})
