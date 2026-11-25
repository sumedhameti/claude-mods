/**
 * What the network is doing: `training` while Claude thinks or runs tools,
 * `feedforward` while it writes the answer, `done` once the turn ended.
 * `idle` (no band) before the first turn and once a turn's fade-out is over.
 */
export type MinnMode = 'idle' | 'training' | 'feedforward' | 'done' | 'aborted'

export type MinnCircuit = {
  mode: MinnMode
  /** The main-loop turn the mode belongs to. */
  turnId: string
  /** The current trajectory: per hidden layer, a bitmask of measured qubits. */
  trajectory: number[]
  /** The current training step's shots, a trajectory each, sampled afresh per step. */
  shots: number[][]
  /** When the mode last changed, in ms since the epoch. */
  changedAt: number
  /** When the turn started (the band's fade-in), in ms since the epoch. */
  startedAt: number
  /** When the pass now running began: the next is sampled one period later. */
  passAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'minn-circuit': { circuit: Shaped<MinnCircuit>; isHidden: boolean }
  }
}
