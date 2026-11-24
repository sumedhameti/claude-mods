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
const current = { circuit: { mode: 'idle', turnId: 't1', trajectory: TRAJ, changedAt: 0 } as object }

const seed = (on: any) => {
  on('state.get', (_: unknown, e: { key: string }) =>
    e.key === 'circuit'
      ? { value: { value: { shape: 'circuit-2', value: current.circuit }, version: 1 } }
      : { value: { value: false, version: 1 } },
  )
  on('clock.now', () => ({ value: 100000 }))
}

const render = async ($: any, mode: string, changedAt = 0) => {
  current.circuit = { mode, turnId: 't1', trajectory: TRAJ, changedAt }
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = (await ui.find({ type: 'Svg' })) as any
  await ui.unmount()
  return { source: String(svg?.props?.source ?? ''), props: svg?.props ?? {} }
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

test('one built circuit, wordless, drawn as a plain image', async ($, on) => {
  seed(on)
  const { source, props } = await render($, 'idle')
  expect(source.includes('<text')).toBe(false)
  expect(props.isInteractive).toBeUndefined()
  // Six layers of 6 qubits on alternating bonds: 3 + 2 + 3 + 2 + 3 + 2.
  expect(count(source, /class="ga"/g)).toBe(9)
  expect(count(source, /class="gb"/g)).toBe(6)
  // No pulses while at rest.
  expect(count(source, /class="(pf|shot|upd)/g)).toBe(0)
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
  expect(count(source, /class="score"/g)).toBe(15)
  expect(count(source, /class="cost"/g)).toBe(7)
  expect(count(source, /class="upd/g) > 0).toBe(true)
  // Nothing runs backward, and no answer pulse.
  expect(count(source, /class="pf/g)).toBe(0)
  // Within what an Svg takes.
  expect(source.length < 131072).toBe(true)
  console.log('TRAINING_SVG_CHARS ' + source.length)
})

test('finished: outputs lit, nothing moving', async ($, on) => {
  seed(on)
  const { source } = await render($, 'done')
  console.log('DONE_BEGIN' + source + 'DONE_END')
  expect(count(source, /class="n lit"/g)).toBe(7)
  expect(count(source, /class="(pf|shot|upd)/g)).toBe(0)
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
