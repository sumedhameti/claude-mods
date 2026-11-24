/**
 * What the network is doing: `training` while Claude thinks or runs tools,
 * `feedforward` while it writes the answer, `done` once the turn ended.
 */
export type MinnMode = 'idle' | 'training' | 'feedforward' | 'done' | 'aborted'

export type MinnCircuit = {
  mode: MinnMode
  /** The main-loop turn the mode belongs to. */
  turnId: string
  /** The current trajectory: per hidden layer, a bitmask of measured qubits. */
  trajectory: number[]
  /** When the mode last changed, in ms since the epoch. */
  changedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'minn-circuit': { circuit: Shaped<MinnCircuit>; isHidden: boolean }
  }
}
