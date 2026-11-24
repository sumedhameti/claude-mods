import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'bloch-spinner',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'desktop',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 80 },
} as const

type Found = { props: { source: string; alt: string } } | undefined
const svgOf = async (ui: { find: (q: never) => Promise<unknown> }) => (await ui.find({ type: 'Svg' } as never)) as Found

test('above the message box: gates while thinking, measured once text streams, gates again on a tool call, the bit kept after', async ($, on) => {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  let step = 0
  // The model beneath: some text and a tool call, then the final answer.
  on('turn.step', async function* (_, e) {
    step += 1
    if (step === 1) {
      yield { kind: 'text', index: 0, text: 'Let me check ' } as never
      yield { kind: 'text', index: 0, text: 'the files.' } as never
      yield { kind: 'tool', index: 1, id: 'tool1', name: 'Bash' } as never
    } else {
      yield { kind: 'text', index: 0, text: 'All done.' } as never
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  const clock = mock.clock(on)
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)

  const band = await $.ui.mount(BAND as never)
  const first = await svgOf(band)
  expect(first?.props.alt).toMatch(/acted on by gates/)
  expect(first?.props.source.length).toBeLessThan(131072)
  // SMIL drops an animation whose keyTimes don't pair with its values or don't climb from 0 to 1.
  const tag = first!.props.source.match(/<animate attributeName="x2" values="([^"]*)" keyTimes="([^"]*)"/)!
  const times = tag[2]!.split(';').map(Number)
  expect(tag[1]!.split(';').length).toBe(times.length)
  expect(times[0]).toBe(0)
  expect(times[times.length - 1]).toBe(1)
  expect(times.every((t, i) => i === 0 || t > times[i - 1]!)).toBe(true)

  await clock.advance(3000)
  const s1 = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)

  // Text arrives: measured, shown in the working row with its bit; nothing under the text.
  await s1.next()
  await band.redraw()
  const m = await svgOf(band)
  expect(m?.props.alt).toMatch(/Qubit measured: [01]/)
  expect((await band.find({ type: 'Text', text: /^[01]$/ }))?.text).toBe(m!.props.alt.slice(-1))

  // The tool call starts: gates act again.
  await s1.next()
  await s1.next()
  await band.redraw()
  expect((await svgOf(band))?.props.alt).toMatch(/acted on by gates/)
  expect(await band.findAll({ type: 'Text' })).toHaveLength(0)
  while (!(await s1.next()).done) {}

  // The final answer: measured again.
  const s2 = $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 3 } as never)
  while (!(await s2.next()).done) {}
  await band.redraw()
  expect((await svgOf(band))?.props.alt).toMatch(/Qubit measured: [01]/)

  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  await band.redraw()
  expect((await svgOf(band))?.props.alt).toMatch(/Qubit measured: [01]/)
  await band.unmount()

  // The terminal keeps its own working line.
  const term = await $.ui.mount({ ...BAND, surface: "terminal" } as never)
  expect(await term.drawn()).toMatchObject({ type: 'engine' })
  await term.unmount()
})
