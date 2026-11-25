import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'minn-circuit',
  component: 'AbovePrompt',
  requestId: 'minn-circuit',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const TRAJ = [0b100101, 0b010010, 0b001100, 0b110001, 0b001010, 0b010100]
const current = { circuit: { mode: 'idle', turnId: 't1', trajectory: TRAJ, shots: [] as number[][], changedAt: 0, startedAt: 0, passAt: 0 } as object }

const seed = (on: any) => {
  on('state.get', (_: unknown, e: { key: string }) =>
    e.key === 'circuit'
      ? { value: { value: { shape: 'circuit-4', value: current.circuit }, version: 1 } }
      : { value: { value: false, version: 1 } },
  )
  on('clock.now', () => ({ value: 100000 }))
}

// The clock reads 100000. By default the turn started long ago (no fade-in).
const render = async ($: any, mode: string, changedAt = 0, startedAt = 0, shots: number[][] = []) => {
  current.circuit = { mode, turnId: 't1', trajectory: TRAJ, shots, changedAt, startedAt, passAt: changedAt }
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = (await ui.find({ type: 'Svg' })) as any
  await ui.unmount()
  return { source: String(svg?.props?.source ?? ''), props: svg?.props ?? {} }
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

test('one built circuit, wordless, drawn as a plain image', async ($, on) => {
  seed(on)
  const { source, props } = await render($, 'feedforward')
  expect(source.includes('<text')).toBe(false)
  expect(props.isInteractive).toBeUndefined()
  // Six layers of 6 qubits on alternating bonds: 3 + 2 + 3 + 2 + 3 + 2.
  expect(count(source, /class="ga"/g)).toBe(9)
  expect(count(source, /class="gb"/g)).toBe(6)
  // Long after the turn started: no fade-in, no fade-out.
  expect(count(source, /class="(fi|fo)"/g)).toBe(0)
})

test('no band before the first turn or between turns', async ($, on) => {
  seed(on)
  expect((await render($, 'idle')).source).toBe('')
  // The turn ended long ago: its fade-out is over.
  expect((await render($, 'done', 0)).source).toBe('')
  expect((await render($, 'aborted', 0)).source).toBe('')
})

test('fades in when a message starts the turn, resuming on a redraw', async ($, on) => {
  seed(on)
  // The turn started 200ms ago: the fade-in is a third of the way through.
  const { source } = await render($, 'training', 99800, 99800)
  expect(source.includes('<g class="fi" style="animation-delay:-0.20s">')).toBe(true)
  expect(count(source, /class="fo"/g)).toBe(0)
})

test('fades out after the last feed-forward pass, then is gone', async ($, on) => {
  seed(on)
  // A second after the end: the final pass is still running, the fade waits.
  const early = (await render($, 'done', 99000)).source
  expect(early.includes('<g class="fo" style="animation-delay:0.80s">')).toBe(true)
  // Two seconds after: mid-fade, picked up where it was.
  const mid = (await render($, 'done', 98000)).source
  expect(mid.includes('<g class="fo" style="animation-delay:-0.20s">')).toBe(true)
  // An interrupted turn fades at once.
  const cut = (await render($, 'aborted', 99900)).source
  expect(cut.includes('<g class="fo" style="animation-delay:-0.10s">')).toBe(true)
})

test('feed-forward runs a left-to-right pulse over the trajectory', async ($, on) => {
  seed(on)
  const { source } = await render($, 'feedforward')
  console.log('FF_BEGIN' + source + 'FF_END')
  expect(count(source, /class="pf/g) > 0).toBe(true)
  expect(count(source, /class="shot/g)).toBe(0)
  // Meters only at this trajectory's measured sites: 3+2+2+3+2+2.
  expect(count(source, /class="m"/g)).toBe(14)
})

test('training runs REINFORCE steps: shots, scores, cost, one update', async ($, on) => {
  seed(on)
  const { source } = await render($, 'training')
  console.log('TR_BEGIN' + source + 'TR_END')
  // Every site is a possible meter, sampled anew per shot.
  expect(count(source, /class="m idle"/g)).toBe(6 * 6)
  // Four forward shots, gathering scores, a cost flash, one update of all.
  expect(count(source, /class="shot/g) > 0).toBe(true)
  expect(count(source, /class="score [ab]"/g)).toBe(15)
  // In brighter shades of the circuit's own colors: no orange.
  expect(source.includes('#ffb02e')).toBe(false)
  expect(count(source, /class="cost"/g)).toBe(7)
  expect(count(source, /class="upd/g) > 0).toBe(true)
  // Nothing runs backward, and no answer pulse.
  expect(count(source, /class="pf/g)).toBe(0)
  // Within what an Svg takes.
  expect(source.length < 131072).toBe(true)
  console.log('TRAINING_SVG_CHARS ' + source.length)
})

test('the turn ends on one full forward pass that lights the outputs', async ($, on) => {
  seed(on)
  // The clock reads 100000: the turn ended a second ago.
  const { source } = await render($, 'done', 99000)
  console.log('END_BEGIN' + source + 'END_END')
  // One pass, played once (no loop), from the inputs to the outputs...
  expect(count(source, /class="pfo/g) > 0).toBe(true)
  expect(source.includes('ffo 0.29s ease-out 1 both')).toBe(true)
  // ...and the outputs light as it arrives, not before.
  expect(count(source, /class="n end"/g)).toBe(7)
  expect(count(source, /class="n lit"/g)).toBe(0)
  expect(count(source, /class="(pf |pf"|shot|upd)/g)).toBe(0)
})

test('each training step draws the shots it sampled', async ($, on) => {
  seed(on)
  const all = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => 0b111111))
  const one = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => 0b000001))
  const many = (await render($, 'training', 0, 0, all)).source
  const few = (await render($, 'training', 0, 0, one)).source
  // A shot lights a meter at each site it measured: 36 per shot, or 6.
  expect(count(many, /<rect class="shot fill"[^>]*width="11"/g)).toBe(4 * 36)
  expect(count(few, /<rect class="shot fill"[^>]*width="11"/g)).toBe(4 * 6)
})
