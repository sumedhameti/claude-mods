/** α = a[0] + i a[1], β = a[2] + i a[3] */
export type Amp = [number, number, number, number]

export type Gate = { axis: [number, number, number]; angle: number }

/** Gates turning the qubit: amps[k] is the state before gate k, the last the state after all. */
export type Moving = { kind: 'moving'; startedAt: number; amps: Amp[]; gates: Gate[] }

/** Measured at `at` (ms): the vector slides from `from` to the outcome's pole and stays. */
export type Measured = { kind: 'measured'; at: number; from: Amp; outcome: 0 | 1 }

export type Phase = Moving | Measured

declare module 'claude-code' {
  interface PluginState {
    'bloch-spinner': {
      phase: Shaped<Phase>
    }
  }
}
