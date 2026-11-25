import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { MinnCircuit, MinnMode } from '../types'

const OLD_PANE = 'minn-circuit' // the side pane of earlier versions

// ---- the network (after Fig. 1 of arXiv:2603.19200) -----------------------
//
// Layer l is U_l then K_l: one column of two-qubit matchgates on alternating
// bonds (odd layers (1,2)(3,4)..., even layers (2,3)(4,5)...), then a
// projective Z measurement on each qubit with probability p. The outcomes of
// K_l feed forward through W^l into the angles of U_{l+1}. The input
// perceptron feeds U_1's angles (W^0 x); the output perceptron reads the last
// layer's outcomes (W^L mu^L + b^L), unmeasured sites counting as 0.

const QUBITS = 6
const LAYERS = 6
const INPUTS = 10
const OUTPUTS = 7
const P_MEASURE = 0.5 // the paper's p (Table I)

const randomMask = () => {
  let mask = 0
  for (let q = 0; q < QUBITS; q++) if (Math.random() < P_MEASURE) mask |= 1 << q
  if (mask === 0) mask = 1 << Math.floor(Math.random() * QUBITS)
  return mask
}
const sampleTrajectory = () => Array.from({ length: LAYERS }, randomMask)

/** The bonds layer `l` (0-based) acts on: odd bonds first, then even. */
const bonds = (l: number) => {
  const out: number[] = []
  for (let q = l % 2; q + 1 < QUBITS; q += 2) out.push(q)
  return out
}

const ALL = Array.from({ length: QUBITS }, (_, q) => q)
const measured = (mask: number) => ALL.filter(q => (mask & (1 << q)) !== 0)

const FIXED_TRAJECTORY = [0b100101, 0b010010, 0b001100, 0b110001, 0b001010, 0b010100]

const EMPTY: MinnCircuit = {
  mode: 'idle',
  turnId: '',
  trajectory: FIXED_TRAJECTORY,
  shots: [],
  changedAt: 0,
  startedAt: 0,
  passAt: 0,
}

const circuit = atom({ plugin: 'minn-circuit', key: 'circuit' } as const, EMPTY, { shape: 'circuit-4' })
const isHidden = atom({ plugin: 'minn-circuit', key: 'isHidden' } as const, false)

// ---- geometry: time runs left to right -----------------------------------
//
// The band draws the image at its full width, so its height follows W / H:
// spread wide (W about 11.5 H) to keep the band low.

const H = 112
const DY = 15
const wy = (q: number) => H / 2 + (q - (QUBITS - 1) / 2) * DY
const R = 3.5
const X_INPUT = 22
const X_GATE0 = 140
const GATE_W = 18
const GATE_TO_METER = 52
const METER = 11
const PITCH = 188
const xGate = (l: number) => X_GATE0 + l * PITCH
const xMeter = (l: number) => xGate(l) + GATE_W + GATE_TO_METER
const LAST_METER_END = xMeter(LAYERS - 1) + METER
const X_OUTPUT = LAST_METER_END + 100
const W = X_OUTPUT + 22
/** Drawn wider than its coordinates so the band scales it to fill. */
const DRAWN_W = 1400

const gateMid = (q: number) => (wy(q) + wy(q + 1)) / 2
const neuronYs = (count: number, inset: number) =>
  Array.from({ length: count }, (_, i) => inset + ((H - 2 * inset) * i) / (count - 1))

// ---- motion ---------------------------------------------------------------
//
// Every piece belongs to a stage, in forward order (inputs, W^0, U_1, K_1,
// W^1, ... outputs).
//
// Feed-forward (writing the answer): one bright pulse runs the stages left to
// right over a single trajectory, again and again.
//
// Training (REINFORCE, as the paper trains): one gradient step per loop.
//   1. a burst of faint forward shots, each on its own sampled trajectory;
//   2. meanwhile each gate column gathers its local score, d log p(tau);
//   3. the outputs flash as the shots are scored, C(tau) - B;
//   4. every weight and gate flashes at once: the update. Nothing runs
//      backward: there is no chain rule through a measurement.

const STAGES = 3 * LAYERS + 3
const stage = {
  inputs: 0,
  inputLines: 1,
  gates: (l: number) => 2 + 3 * l,
  meters: (l: number) => 3 + 3 * l,
  forward: (l: number) => 4 + 3 * l, // K_l into U_{l+1}
  outputLines: 3 * LAYERS + 1,
  outputs: 3 * LAYERS + 2,
}

const TRAIN = { period: 3.2, shots: 4, shotGap: 0.38, step: 0.043 }
// The answer's pulse travels and flashes exactly as fast as a training shot.
const FF = { step: TRAIN.step, period: STAGES * TRAIN.step + 0.45 }
const FLASH = { peak: 0.048, gone: 0.29 } // seconds into a piece's flash

// The band fades in when a turn starts (a message sent) and fades out once
// the turn's last feed-forward pass has lit the outputs; then it is gone.
const FADE = {
  in: 0.8, // as long as the fade-out
  /** Seconds after the turn ends: the final pass lights the outputs by ~1.2s. */
  outAt: 1.8,
  /** An interrupted turn has no final pass: it fades at once. */
  outAtAborted: 0,
  out: 0.8,
}
const outAt = (mode: MinnMode) => (mode === 'aborted' ? FADE.outAtAborted : FADE.outAt)
/** How long after the turn ends the band is drawn at all. */
export const goneMs = (mode: MinnMode) => Math.round((outAt(mode) + FADE.out) * 1000)
const isEnded = (mode: MinnMode) => mode === 'done' || mode === 'aborted'
/** Whether the band has nothing to show: no turn yet, or its fade-out is over. */
export const isGone = (c: MinnCircuit, now: number) =>
  c.mode === 'idle' || (isEnded(c.mode) && now - c.changedAt >= goneMs(c.mode))

// Shots to fall back on when none were sampled (a value from before a reload).
const SHOT_TRAJECTORIES = Array.from({ length: TRAIN.shots }, (_, k) =>
  Array.from({ length: LAYERS }, (_, l) => {
    let mask = 0
    for (let q = 0; q < QUBITS; q++) if ((((k + 1) * 73 + l * 37 + q * 19 + k * l * q) * 2654435761) % 997 < 498) mask |= 1 << q
    return mask === 0 ? 1 << ((k + l) % QUBITS) : mask
  }),
)

// Every pass samples its own trajectory, as in the paper: each qubit is
// measured with probability p after each layer, afresh on every shot. A timer
// samples new ones at each pass boundary (a training step's shots, a
// feed-forward pulse), and the redraw starts the loop over on them.
const sampleShots = () => Array.from({ length: TRAIN.shots }, sampleTrajectory)
const periodMs = (mode: MinnMode) => (mode === 'training' ? TRAIN.period : FF.period) * 1000

const pct = (s: number) => `${((s / TRAIN.period) * 100).toFixed(1)}%`

const STYLE = `
.bg{fill:url(#bg)}
.w{stroke:#4a50b8;stroke-width:1.3;opacity:.85}
.si{stroke:#a78bfa;stroke-width:.6;opacity:.3;fill:none}
.sf{stroke:#b6ff3b;stroke-width:.6;opacity:.3;fill:none}
.st{stroke:#8b7bd8;stroke-width:.5;opacity:.18;fill:none}
.so{stroke:#b6ff3b;stroke-width:.6;opacity:.35;fill:none}
.n{fill:#140f2a;stroke:#c4b5fd;stroke-width:1.4}
.lit{fill:#c4b5fd}
.ga{fill:rgba(34,229,255,.18);stroke:#22e5ff;stroke-width:1.5}
.gb{fill:rgba(255,61,242,.18);stroke:#ff3df2;stroke-width:1.5}
.m rect{fill:rgba(182,255,59,.1);stroke:#b6ff3b;stroke-width:1.2}
.m path{fill:none;stroke:#b6ff3b;stroke-width:1.2;stroke-linecap:round}
.m.idle{opacity:.28}
.glow{filter:url(#glow)}
.dim{opacity:.45}
.pf{opacity:0;animation:ff ${FF.period.toFixed(2)}s ease-out infinite}
@keyframes ff{0%{opacity:0}${((FLASH.peak / FF.period) * 100).toFixed(1)}%{opacity:1}${((FLASH.gone / FF.period) * 100).toFixed(1)}%{opacity:0}100%{opacity:0}}
.pf path{stroke:#eafcff;stroke-width:1.6;fill:none}
.pf.fill{fill:#eafcff}
.pfo{opacity:0;animation:ffo ${FLASH.gone}s ease-out 1 both}
@keyframes ffo{0%{opacity:0}${((FLASH.peak / FLASH.gone) * 100).toFixed(1)}%{opacity:1}100%{opacity:0}}
.pfo path{stroke:#eafcff;stroke-width:1.6;fill:none}
.pfo.fill{fill:#eafcff}
.end{animation:light .35s ease-out 1 both}
@keyframes light{from{fill:#140f2a}to{fill:#c4b5fd}}
.shot{opacity:0;animation:shot ${TRAIN.period}s ease-out infinite}
@keyframes shot{0%{opacity:0}${pct(FLASH.peak)}{opacity:.75}${pct(FLASH.gone)}{opacity:0}100%{opacity:0}}
.shot path{stroke:#bfefff;stroke-width:.9;fill:none}
.shot.fill{fill:#bfefff}
.score{opacity:0;animation:score ${TRAIN.period}s linear infinite}
@keyframes score{0%{opacity:0}${pct(1.6)}{opacity:.42}${pct(2.0)}{opacity:.55}${pct(2.25)}{opacity:0}100%{opacity:0}}
.cost{fill:#ece6ff;opacity:0;animation:cost ${TRAIN.period}s ease-out infinite}
@keyframes cost{0%{opacity:0}${pct(1.6)}{opacity:0}${pct(1.7)}{opacity:1}${pct(2.0)}{opacity:0}100%{opacity:0}}
.upd{opacity:0;animation:upd ${TRAIN.period}s ease-out infinite}
@keyframes upd{0%{opacity:0}${pct(2.0)}{opacity:0}${pct(2.08)}{opacity:1}${pct(2.45)}{opacity:0}100%{opacity:0}}
.upd path{stroke:#d9ceff;stroke-width:1;fill:none}
/* Training lights each piece in a brighter shade of its own color. */
.score.a{fill:#22e5ff}
.score.b{fill:#ff3df2}
.upd.fill.a{fill:#9ff5ff}
.upd.fill.b{fill:#ff9ef9}
.fi{animation:fi ${FADE.in}s ease-in-out 1 both}
@keyframes fi{from{opacity:0}to{opacity:1}}
.fo{animation:fo ${FADE.out}s ease-in-out 1 both}
@keyframes fo{from{opacity:1}to{opacity:0}}
`

const DEFS =
  '<defs>' +
  '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07081a"/><stop offset=".55" stop-color="#0b0820"/><stop offset="1" stop-color="#14061f"/></linearGradient>' +
  '<filter id="glow" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
  '</filter></defs>'

const f1 = (n: number) => n.toFixed(1)
const at = (s: number) => ` style="animation-delay:${s.toFixed(2)}s"`

type Pt = { x: number; y: number }

/** Dense weights between two layers as one path, each landing spread a little. */
const weights = (from: Pt[], to: Pt[], spread: number) =>
  from
    .flatMap((a, i) =>
      to.map(b => {
        const off = from.length === 1 ? 0 : (i / (from.length - 1) - 0.5) * spread
        return `M${f1(a.x)} ${f1(a.y)}L${f1(b.x)} ${f1(b.y + off)}`
      }),
    )
    .join('')

const path = (cls: string, d: string, style = '') => (d === '' ? '' : `<path class="${cls}"${style} d="${d}"/>`)
const wrap = (cls: string, style: string, inner: string) => `<g class="${cls}"${style}>${inner}</g>`

const gateRect = (l: number, q: number, cls: string, style = '') =>
  `<rect class="${cls}"${style} x="${xGate(l)}" y="${f1(wy(q) - 4.5)}" width="${GATE_W}" height="${DY + 9}" rx="5"/>`

const meterShape = (q: number, x: number, cls: string) => {
  const top = wy(q) - METER / 2
  const cx = x + METER / 2
  return (
    `<g class="${cls}">` +
    `<rect x="${f1(x)}" y="${f1(top)}" width="${METER}" height="${METER}" rx="2"/>` +
    `<path d="M${f1(cx - 3.4)} ${f1(top + 7.8)}A3.4 3.4 0 0 1 ${f1(cx + 3.4)} ${f1(top + 7.8)}"/>` +
    `<path d="M${f1(cx)} ${f1(top + 7.8)}L${f1(cx + 2.6)} ${f1(top + 3.4)}"/>` +
    '</g>'
  )
}

const meterFill = (q: number, x: number, cls: string, style = '') =>
  `<rect class="${cls}"${style} x="${f1(x)}" y="${f1(wy(q) - METER / 2)}" width="${METER}" height="${METER}" rx="2"/>`

const neuron = (p: Pt, cls: string, style = '') =>
  `<circle class="${cls}"${style} cx="${f1(p.x)}" cy="${f1(p.y)}" r="${R}"/>`

// The fixed points of the network.
const INPUT_PTS = neuronYs(INPUTS, 10).map(y => ({ x: X_INPUT, y }))
const OUTPUT_PTS = neuronYs(OUTPUTS, 14).map(y => ({ x: X_OUTPUT, y }))
const gatesIn = (l: number) => bonds(l).map(q => ({ x: xGate(l), y: gateMid(q) }))
const meterOut = (l: number, sites: number[]) => sites.map(q => ({ x: xMeter(l) + METER, y: wy(q) }))
const lastOut = (sites: number[]) => sites.map(q => ({ x: LAST_METER_END, y: wy(q) }))

/** The weights a trajectory drives, layer by layer: W^0, W^1..W^{L-1}, W^L. */
const drivenWeights = (traj: number[]) => ({
  w0: weights(INPUT_PTS, gatesIn(0), DY),
  wl: Array.from({ length: LAYERS - 1 }, (_, l) => weights(meterOut(l, measured(traj[l] ?? 0)), gatesIn(l + 1), DY * 0.9)),
  wL: weights(lastOut(measured(traj[LAYERS - 1] ?? 0)), OUTPUT_PTS, 0),
})

/** One forward pass over `traj`, its stages lit from `start` seconds, `step` apart. */
const forwardPass = (traj: number[], cls: string, start: number, step: number) => {
  const t = (s: number) => at(start + s * step)
  const w = drivenWeights(traj)
  const out: string[] = []
  out.push(INPUT_PTS.map(p => neuron(p, `${cls} fill`, t(stage.inputs))).join(''))
  out.push(wrap(cls, t(stage.inputLines), path('', w.w0)))
  for (let l = 0; l < LAYERS; l++) {
    out.push(bonds(l).map(q => gateRect(l, q, `${cls} fill`, t(stage.gates(l)))).join(''))
    out.push(measured(traj[l] ?? 0).map(q => meterFill(q, xMeter(l), `${cls} fill`, t(stage.meters(l)))).join(''))
    if (l + 1 < LAYERS) out.push(wrap(cls, t(stage.forward(l)), path('', w.wl[l] ?? '')))
  }
  out.push(wrap(cls, t(stage.outputLines), path('', w.wL)))
  out.push(OUTPUT_PTS.map(p => neuron(p, `${cls} fill`, t(stage.outputs))).join(''))
  return out.join('')
}

/** The whole network for one mode, as one SVG document with no text on it. */
export const drawCircuit = (c: MinnCircuit, now: number) => {
  const mode = c.mode
  // The answer is out: one last full pass, ending as the outputs light.
  const sinceEnd = (now - c.changedAt) / 1000
  const isEnding = mode === 'done' && sinceEnd < goneMs(mode) / 1000
  // A redraw mid-animation picks up where the last one was, never from the top.
  const sinceStart = (now - c.startedAt) / 1000
  const isTraining = mode === 'training'
  const traj = c.trajectory.length === LAYERS ? c.trajectory : FIXED_TRAJECTORY

  const net: string[] = [] // wires and weights
  const lit: string[] = [] // gates, meters, neurons: these glow
  const over: string[] = [] // the motion

  net.push(ALL.map(q => `<line class="w" x1="${X_GATE0 - 30}" y1="${f1(wy(q))}" x2="${f1(LAST_METER_END + 8)}" y2="${f1(wy(q))}"/>`).join(''))

  // Weights. Training shows every weight W^l can hold, since all of them
  // learn; at rest and in a forward pass, those this trajectory drives.
  const every = Array.from({ length: LAYERS }, () => (1 << QUBITS) - 1)
  const all = drivenWeights(every)
  const shown = isTraining ? all : drivenWeights(traj)
  net.push(path('si', shown.w0))
  net.push(shown.wl.map(d => path(isTraining ? 'st' : 'sf', d)).join(''))
  net.push(path(isTraining ? 'st' : 'so', shown.wL))

  // Neurons, gates and meters.
  lit.push(INPUT_PTS.map(p => neuron(p, 'n')).join(''))
  for (let l = 0; l < LAYERS; l++) {
    lit.push(bonds(l).map(q => gateRect(l, q, l % 2 === 0 ? 'ga' : 'gb')).join(''))
    // Training samples a new set of sites per shot, so every site is a
    // possible meter; otherwise this trajectory's measured sites.
    const sites = isTraining ? ALL : measured(traj[l] ?? 0)
    lit.push(sites.map(q => meterShape(q, xMeter(l), isTraining ? 'm idle' : 'm')).join(''))
  }
  const outCls = isEnding ? 'n end' : mode === 'done' ? 'n lit' : 'n'
  const outLitAt = isEnding ? at(stage.outputs * FF.step - sinceEnd) : ''
  lit.push(OUTPUT_PTS.map(p => neuron(p, outCls, outLitAt)).join(''))

  if (mode === 'feedforward') over.push(forwardPass(traj, 'pf', 0, FF.step))
  if (isEnding) over.push(forwardPass(traj, 'pfo', -sinceEnd, FF.step))

  if (isTraining) {
    // 1. The shots, each on its own trajectory.
    const shots = c.shots.length === TRAIN.shots ? c.shots : SHOT_TRAJECTORIES
    shots.forEach((shot, k) => over.push(forwardPass(shot, 'shot', k * TRAIN.shotGap, TRAIN.step)))
    // 2. The local scores gathering in each gate column.
    for (let l = 0; l < LAYERS; l++) over.push(bonds(l).map(q => gateRect(l, q, `score ${l % 2 === 0 ? 'a' : 'b'}`)).join(''))
    // 3. The cost, at the outputs.
    over.push(OUTPUT_PTS.map(p => neuron(p, 'cost')).join(''))
    // 4. The update: every weight and gate at once.
    over.push(wrap('upd', '', path('', all.w0) + all.wl.map(d => path('', d)).join('') + path('', all.wL)))
    for (let l = 0; l < LAYERS; l++) over.push(bonds(l).map(q => gateRect(l, q, `upd fill ${l % 2 === 0 ? 'a' : 'b'}`)).join(''))
  }

  const body = `${net.join('')}<g class="glow">${lit.join('')}${over.join('')}</g>`
  const isDim = mode === 'idle' || mode === 'aborted'
  const drawnH = Math.round((DRAWN_W * H) / W)
  let whole = `<rect class="bg" width="${W}" height="${H}" rx="10"/>` + (isDim ? `<g class="dim">${body}</g>` : body)
  if (isEnded(mode)) whole = wrap('fo', at(outAt(mode) - sinceEnd), whole)
  if (sinceStart < FADE.in) whole = wrap('fi', at(-sinceStart), whole)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DRAWN_W}" height="${drawnH}" viewBox="0 0 ${W} ${H}">` +
    `<style>${STYLE}</style>${DEFS}` +
    whole +
    '</svg>'
  )
}

const describe = (mode: MinnMode) =>
  mode === 'training'
    ? 'MINN circuit training'
    : mode === 'feedforward'
      ? 'MINN circuit running a feed-forward pass'
      : 'MINN circuit at rest'

// ---- hooks ---------------------------------------------------------------

/** The pending resample; a reload starts with none (its timers stop). */
let resample: Timer | undefined

const stopResampling = () => {
  resample?.cancel()
  resample = undefined
}

/** At the end of the pass now running, sample the next one's trajectories. */
const scheduleResample = ($: EngineInterface, c: MinnCircuit, now: number) => {
  stopResampling()
  if (c.mode !== 'training' && c.mode !== 'feedforward') return
  const { turnId, mode, passAt } = c
  resample = $.clock.after(Math.max(50, passAt + periodMs(mode) - now), () => {
    void (async () => {
      const at = await $.clock.now()
      const next = await update($, circuit, (cur): MinnCircuit =>
        cur.turnId !== turnId || cur.mode !== mode || cur.passAt !== passAt
          ? cur
          : { ...cur, trajectory: sampleTrajectory(), shots: sampleShots(), passAt: at },
      )
      if (next.passAt !== passAt) scheduleResample($, next, at)
    })().catch(() => undefined)
  })
}

/** Switch mode for the running main turn; the new pass samples afresh. */
const setMode = async ($: EngineInterface, turnId: string, mode: MinnMode) => {
  const now = await $.clock.now()
  const next = await update($, circuit, (cur): MinnCircuit => {
    if (cur.turnId !== turnId || cur.mode === mode || cur.mode === 'done' || cur.mode === 'aborted') return cur
    return { ...cur, mode, trajectory: sampleTrajectory(), shots: sampleShots(), changedAt: now, passAt: now }
  })
  if (next.turnId === turnId && next.mode === mode && next.passAt === now) scheduleResample($, next, now)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'minn', description: 'Show or hide the MINN circuit band' })
    void $.ui.close({ id: OLD_PANE }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'minn' }, async $ => {
    const nowHidden = await update($, isHidden, hidden => !hidden)
    return { text: nowHidden ? 'MINN band hidden.' : 'MINN band shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const c = await update($, circuit, (cur): MinnCircuit => ({
      ...cur,
      mode: 'training',
      turnId: e.turnId,
      trajectory: sampleTrajectory(),
      shots: sampleShots(),
      changedAt: now,
      startedAt: now,
      passAt: now,
    }))
    scheduleResample($, c, now)
    return next(e)
  })

  // Writing the answer is a forward pass; thinking and tool calls are training.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    let shown: MinnMode | null = null
    for await (const chunk of next(e)) {
      if (isMain) {
        const mode: MinnMode | null =
          chunk.kind === 'text' ? 'feedforward' : chunk.kind === 'thinking' || chunk.kind === 'tool' ? 'training' : null
        if (mode !== null && mode !== shown) {
          shown = mode
          void setMode($, e.turnId, mode).catch(() => undefined)
        }
      }
      yield chunk
    }
  })

  // A tool running between steps is still training.
  on('tool.call', async ($, e, next) => {
    const c = await read($, circuit)
    if (c.mode === 'feedforward') void setMode($, c.turnId, 'training').catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e)) // it only watches: a failure lets the call run

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const mode: MinnMode = e.isAborted ? 'aborted' : 'done'
    stopResampling()
    await update($, circuit, (cur): MinnCircuit => (cur.turnId !== e.turnId ? cur : { ...cur, mode, changedAt: now }))
    // Once the fade-out is over, put the band away (a write redraws it).
    $.clock.after(goneMs(mode) + 100, () => {
      void update($, circuit, (cur): MinnCircuit =>
        cur.turnId === e.turnId && cur.mode === mode ? { ...cur, mode: 'idle' } : cur,
      ).catch(() => undefined)
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const c = await read($, circuit)
    const now = await $.clock.now()
    // Nothing between turns: it fades in when a message is sent.
    if (isGone(c, now)) return next(e)

    if (e.surface === 'desktop' || e.surface === 'mobile' || e.surface === 'vscode') {
      const { Box, Svg } = $.ui.resolve(e)
      // Drawn as an image, which scales to the band's width with no frame.
      return (
        <Box>
          <Svg source={drawCircuit(c, now)} alt={describe(c.mode)} />
        </Box>
      )
    }

    // The terminal has no Svg: the same network in glyphs, left to right.
    const { Box, Text } = $.ui.resolve(e)
    const rows = ALL.map(q => {
      let s = '○─'
      for (let l = 0; l < LAYERS; l++) {
        const inGate = bonds(l).some(b => b === q || b + 1 === q)
        s += (inGate ? '█' : '─') + '─' + (((c.trajectory[l] ?? 0) & (1 << q)) !== 0 ? '◘' : '─') + '─'
      }
      return s + '○'
    })
    const color = c.mode === 'training' ? 'warning' : 'suggestion'
    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Text color={color} dimColor={c.mode === 'idle' || c.mode === 'aborted'}>
            {row}
          </Text>
        ))}
      </Box>
    )
  })
}
