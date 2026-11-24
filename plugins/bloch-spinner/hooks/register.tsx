import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Amp, Gate, Measured, Moving, Phase } from '../types'

const ZERO: Amp = [1, 0, 0, 0]
const ONE: Amp = [0, 0, 1, 0]

/** One gate every GATE_S seconds: it turns the vector for ANIM_S, then the vector rests. */
const GATE_S = 1.1
const ANIM_S = 0.7
/** Gates per sequence; a long think gets a fresh sequence after REFRESH_S. */
const GATES = 50
const REFRESH_S = 40
/** How long the slide to the measured pole takes. */
const COLLAPSE_S = 0.5
/** Drawn size in CSS pixels: small enough to sit in one thin row. */
const SIZE = 24

const phase = atom(
  { plugin: 'bloch-spinner', key: 'phase' } as const,
  { kind: 'measured', at: 0, from: ZERO, outcome: 0 } as Phase,
  { shape: 'phase-1' },
)

// ---------------------------------------------------------------------------
// Quantum mechanics
// ---------------------------------------------------------------------------

const rand = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32

/**
 * Rotation about unit axis n by angle θ: U = cos(θ/2)·I − i·sin(θ/2)·(n·σ).
 * Every single-qubit gate is one of these up to a global phase, and the Bloch
 * vector rotates by the same θ about the same n.
 */
function rotate(a: Amp, axis: [number, number, number], theta: number): Amp {
  const [ar, ai, br, bi] = a
  const [nx, ny, nz] = axis
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  // (n·σ)ψ:  top = nz·α + (nx − i·ny)·β,  bottom = (nx + i·ny)·α − nz·β
  const tr = nz * ar + nx * br + ny * bi
  const ti = nz * ai + nx * bi - ny * br
  const ur = nx * ar - ny * ai - nz * br
  const ui = nx * ai + ny * ar - nz * bi
  // Uψ = c·ψ − i·s·(n·σ)ψ,  and −i·(x + iy) = y − ix
  return [c * ar + s * ti, c * ai - s * tr, c * br + s * ui, c * bi - s * ur]
}

/** Bloch vector (x, y, z) of α|0⟩ + β|1⟩. */
function bloch([ar, ai, br, bi]: Amp): [number, number, number] {
  return [2 * (ar * br + ai * bi), 2 * (ar * bi - ai * br), ar * ar + ai * ai - br * br - bi * bi]
}

const p0Of = ([ar, ai]: Amp): number => ar * ar + ai * ai

const R2 = Math.SQRT1_2
const PI = Math.PI
const X: [number, number, number] = [1, 0, 0]
const Y: [number, number, number] = [0, 1, 0]
const Z: [number, number, number] = [0, 0, 1]

const ANGLES = [PI / 4, PI / 3, PI / 2, (2 * PI) / 3]

function randomGate(): Gate {
  const r = rand()
  const angle = ANGLES[Math.floor(rand() * ANGLES.length)]!
  if (r < 0.2) return { axis: [R2, 0, R2], angle: PI } // H
  if (r < 0.3) return { axis: X, angle: PI } // X
  if (r < 0.38) return { axis: Y, angle: PI } // Y
  if (r < 0.44) return { axis: Z, angle: PI } // Z
  if (r < 0.52) return { axis: Z, angle: PI / 2 } // S
  if (r < 0.58) return { axis: Z, angle: PI / 4 } // T
  if (r < 0.64) return { axis: X, angle: PI / 2 } // √X
  if (r < 0.78) return { axis: X, angle } // Rx(θ)
  if (r < 0.92) return { axis: Y, angle } // Ry(θ)
  return { axis: Z, angle } // Rz(θ)
}

/** A gate that visibly moves the vector (no Z-rotations of a pole). */
function movingGate(a: Amp): Gate {
  for (let i = 0; i < 8; i++) {
    const g = randomGate()
    const [vx, vy, vz] = bloch(a)
    const along = vx * g.axis[0] + vy * g.axis[1] + vz * g.axis[2]
    if (Math.abs(along) < 0.9) return g
  }
  return { axis: [R2, 0, R2], angle: PI }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

function moving(from: Amp, now: number): Moving {
  const amps: Amp[] = [from]
  const gates: Gate[] = []
  for (let k = 0; k < GATES; k++) {
    const g = movingGate(amps[k]!)
    gates.push(g)
    amps.push(rotate(amps[k]!, g.axis, g.angle))
  }
  return { kind: 'moving', startedAt: now, amps, gates }
}

/** Born rule: P(0) = |α|², P(1) = |β|² = 1 − |α|². */
function measure(from: Amp, now: number): Measured {
  return { kind: 'measured', at: now, from, outcome: rand() < p0Of(from) ? 0 : 1 }
}

/** The state the qubit is in at `now` (ms). */
function ampAt(p: Phase, now: number): Amp {
  if (p.kind === 'measured') return p.outcome === 0 ? ZERO : ONE
  const t = Math.max(0, (now - p.startedAt) / 1000)
  const k = Math.floor(t / GATE_S)
  if (k >= p.gates.length) return p.amps[p.gates.length]!
  const g = p.gates[k]!
  return rotate(p.amps[k]!, g.axis, g.angle * ease(Math.min(1, (t - k * GATE_S) / ANIM_S)))
}

// ---------------------------------------------------------------------------
// Drawing: a small sphere, sized to sit in one thin row. Every drawing is
// synced to the clock (its animations begin in the past), so a redraw picks
// up exactly where the qubit is.
// ---------------------------------------------------------------------------

const AZ = (-35 * PI) / 180
const EL = (18 * PI) / 180
const C = 50
const R = 44
const GRAY = '#8a8f9c'
const ACCENT = '#d97757'
const SAMPLES = 10

type V3 = [number, number, number]

/** Screen point and depth (> 0 toward the viewer) of a point on/in the sphere. */
function project([x, y, z]: V3): [number, number, number] {
  const x1 = x * Math.cos(AZ) - y * Math.sin(AZ)
  const y1 = x * Math.sin(AZ) + y * Math.cos(AZ)
  const v = z * Math.cos(EL) - x1 * Math.sin(EL)
  const depth = x1 * Math.cos(EL) + z * Math.sin(EL)
  return [C + R * y1, C - R * v, depth]
}

const n1 = (v: number) => v.toFixed(1)
const n4 = (v: number) => String(Math.round(v * 10000) / 10000)
const sec = (v: number) => `${v.toFixed(2)}s`

function circlePath(at: (t: number) => V3, front: boolean): string {
  let d = ''
  let pen = false
  for (let k = 0; k <= 64; k++) {
    const [sx, sy, depth] = project(at((k / 64) * 2 * PI))
    if (front ? depth >= 0 : depth < 0) {
      d += `${pen ? 'L' : 'M'}${n1(sx)} ${n1(sy)} `
      pen = true
    } else {
      pen = false
    }
  }
  return d
}

const equator = (t: number): V3 => [Math.cos(t), Math.sin(t), 0]
const [zTopX, zTopY] = project([0, 0, 1])
const [zBotX, zBotY] = project([0, 0, -1])
const FRAME = `<circle cx="${C}" cy="${C}" r="${R}" fill="${GRAY}" fill-opacity="0.12" stroke="${GRAY}" stroke-width="4"/>
<path d="${circlePath(equator, false)}" fill="none" stroke="${GRAY}" stroke-width="2.5" stroke-dasharray="5 5" opacity="0.7"/>
<path d="${circlePath(equator, true)}" fill="none" stroke="${GRAY}" stroke-width="3"/>
<line x1="${n1(zTopX)}" y1="${n1(zTopY)}" x2="${n1(zBotX)}" y2="${n1(zBotY)}" stroke="${GRAY}" stroke-width="2.5" stroke-dasharray="4 5" opacity="0.7"/>`

const OPEN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 108 108" width="${SIZE}" height="${SIZE}">`

type Attr = 'x2' | 'y2' | 'cx' | 'cy'

/** The vector (shaft and tip) drawn at `end`, moved by the animation `anim` builds. */
function vector(end: [number, number, number], anim: (attr: Attr) => string): string {
  return `<line x1="${C}" y1="${C}" x2="${n1(end[0])}" y2="${n1(end[1])}" stroke="${ACCENT}" stroke-width="8" stroke-linecap="round">${anim('x2')}${anim('y2')}</line>
<circle cx="${n1(end[0])}" cy="${n1(end[1])}" r="9" fill="${ACCENT}">${anim('cx')}${anim('cy')}</circle>
<circle cx="${C}" cy="${C}" r="5" fill="${GRAY}"/>`
}

/** The gate sequence as one animation, begun `elapsed` seconds ago. */
function movingSvg(p: Moving, elapsed: number): string {
  const total = p.gates.length * GATE_S
  const xs: string[] = []
  const ys: string[] = []
  const times: string[] = []
  let trails = ''
  p.gates.forEach((g, k) => {
    const pts: [number, number, number][] = []
    for (let j = 0; j <= SAMPLES; j++) {
      const pt = project(bloch(rotate(p.amps[k]!, g.axis, g.angle * ease(j / SAMPLES))))
      pts.push(pt)
      xs.push(n1(pt[0]))
      ys.push(n1(pt[1]))
      times.push(n4((k * GATE_S + (j / SAMPLES) * ANIM_S) / total))
    }
    const start = k * GATE_S - elapsed
    if (start + GATE_S * 1.6 < 0) return // its trail has already faded
    const begin = sec(start)
    trails += `<polyline points="${pts.map(q => `${n1(q[0])},${n1(q[1])}`).join(' ')}" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" opacity="0.5"><animate attributeName="stroke-dashoffset" values="1;0" begin="${begin}" dur="${ANIM_S}s" fill="freeze"/><animate attributeName="opacity" values="0.5;0.5;0" keyTimes="0;0.6;1" begin="${begin}" dur="${sec(GATE_S * 1.6)}" fill="freeze"/></polyline>`
  })
  const last = project(bloch(p.amps[p.gates.length]!))
  xs.push(n1(last[0]))
  ys.push(n1(last[1]))
  times.push('1')
  const kt = times.join(';')
  const values = { x2: xs, y2: ys, cx: xs, cy: ys }
  const anim = (attr: Attr) =>
    `<animate attributeName="${attr}" values="${values[attr].join(';')}" keyTimes="${kt}" begin="${sec(-elapsed)}" dur="${sec(total)}" fill="freeze"/>`
  return `${OPEN}${FRAME}${trails}${vector(last, anim)}</svg>`
}

/** The slide to the measured pole, begun `elapsed` seconds ago, and a ring where it lands. */
function measuredSvg(p: Measured, elapsed: number): string {
  const [x, y, z] = bloch(p.from)
  const theta = Math.acos(Math.max(-1, Math.min(1, z)))
  const phi = Math.atan2(y, x)
  const target = p.outcome === 0 ? 0 : PI
  const pts = Array.from({ length: 13 }, (_, k) => {
    const t = theta + (target - theta) * ease(k / 12)
    return project([Math.sin(t) * Math.cos(phi), Math.sin(t) * Math.sin(phi), Math.cos(t)])
  })
  const end = pts[pts.length - 1]!
  if (elapsed > COLLAPSE_S + 0.6) return `${OPEN}${FRAME}${vector(end, () => '')}</svg>` // settled: one still drawing
  const xs = pts.map(q => n1(q[0])).join(';')
  const ys = pts.map(q => n1(q[1])).join(';')
  const values = { x2: xs, y2: ys, cx: xs, cy: ys }
  const begin = sec(-elapsed)
  const anim = (attr: Attr) =>
    `<animate attributeName="${attr}" values="${values[attr]}" begin="${begin}" dur="${COLLAPSE_S}s" fill="freeze"/>`
  const ringAt = sec(COLLAPSE_S - elapsed)
  const ring = `<circle cx="${n1(end[0])}" cy="${n1(end[1])}" r="9" fill="none" stroke="${ACCENT}" stroke-width="4" opacity="0"><animate attributeName="r" values="9;30" begin="${ringAt}" dur="0.6s" fill="freeze"/><animate attributeName="opacity" values="0.9;0" begin="${ringAt}" dur="0.6s" fill="freeze"/></circle>`
  return `${OPEN}${FRAME}${vector(end, anim)}${ring}</svg>`
}

/** The qubit as drawn now: the sphere, and the measured bit when there is one. */
async function qubitView($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const p = await read($, phase)
  const now = await $.clock.now()
  const { Svg, Text } = $.ui.resolve(e) as unknown as {
    Svg: (props: { key: string; source: string; alt: string; width: number; height: number }) => JSX.Element
    Text: (props: { bold?: boolean; color?: string; children?: unknown }) => JSX.Element
  }
  if (p.kind === 'measured') {
    // Quantised so redraws while text streams draw the same picture.
    const elapsed = Math.round((now - p.at) / 100) / 10
    return [
      <Svg key={`m${p.at}`} source={measuredSvg(p, elapsed)} alt={`Qubit measured: ${p.outcome}`} width={SIZE} height={SIZE} />,
      <Text bold color={ACCENT}>
        {String(p.outcome)}
      </Text>,
    ]
  }
  const elapsed = (now - p.startedAt) / 1000
  return [
    <Svg key={`q${p.startedAt}`} source={movingSvg(p, elapsed)} alt="Qubit on a Bloch sphere, acted on by gates" width={SIZE} height={SIZE} />,
  ]
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** The text block streaming now. */
let block: string | null = null

/** Gates start acting again, from where the qubit is. */
async function move($: EngineInterface) {
  const now = await $.clock.now()
  const p = await read($, phase)
  if (p.kind === 'measured') await update($, phase, () => moving(ampAt(p, now), now))
}

/** Measure the qubit where the gates have left it. */
async function collapse($: EngineInterface) {
  const now = await $.clock.now()
  const p = await read($, phase)
  if (p.kind === 'moving') await update($, phase, () => measure(ampAt(p, now), now))
}

export const register: Register = on => {
  let timer: Timer | null = null

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await move($)
    timer?.cancel()
    timer = $.clock.every(10_000, async () => {
      // A long think: carry on from where the qubit is with a fresh sequence.
      const now = await $.clock.now()
      const p = await read($, phase)
      if (p.kind === 'moving' && now - p.startedAt > REFRESH_S * 1000) {
        await update($, phase, () => moving(ampAt(p, now), now))
      }
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await move($) // a new request: gates act while it thinks
    const stream = next(e)
    for await (const chunk of stream) {
      if (chunk.kind === 'text') {
        const id = `${e.turnId}:${e.index}:${chunk.index}`
        if (block !== id) {
          // Text starts: measure, and hold the result while it streams.
          block = id
          await collapse($)
        }
      } else if ((chunk.kind === 'thinking' || chunk.kind === 'tool') && block !== null) {
        // Thinking or a tool call after text: gates act on the measured state.
        // (Before any text in a step the qubit is already moving.)
        block = null
        await move($)
      }
      yield chunk
    }
    block = null
    return await stream.result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    timer?.cancel()
    timer = null
    block = null
    await collapse($) // the next turn starts from the measured pole
    return next(e)
  })

  // A thin row directly above the message box, the sphere at its right end:
  // always on screen, so the qubit stays in one place through thinking, text
  // and tool calls, and keeps its last measured bit between turns.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" width={e.props.bodyColumns} justifyContent="flex-end" alignItems="center" gap={1}>
        {await qubitView($, e)}
      </Box>
    )
  })
}
