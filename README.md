# claude-mods

Mods for Claude Code: changes to Claude's own interface and behaviour, written as plugins of function hooks. Each mod lives in its own folder under `plugins/`, and this repository is a marketplace that lists them all, so any one can be installed on its own.

| Mod | What it does |
| --- | --- |
| [`minn-circuit`](plugins/minn-circuit) | A neon measurement-induced quantum neural network above the prompt that trains while Claude thinks and runs a forward pass while it answers |
| [`bloch-spinner`](plugins/bloch-spinner) | A qubit on a Bloch sphere above the prompt: random gates turn it while Claude thinks, and it is measured to 0 or 1 when Claude starts answering |

## Installing a mod

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace sumedhameti/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user is first). From a shell:

```bash
claude plugin install <mod> --marketplace sumedhameti/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `sumedhameti/claude-mods`, then **Add plugin**.

For example, `minn-circuit`:

```
/plugin install minn-circuit --marketplace sumedhameti/claude-mods
```

## minn-circuit

A band above the prompt that draws a measurement-induced quantum neural network (MINN, [arXiv:2603.19200](https://arxiv.org/abs/2603.19200)) and animates it with what Claude is doing. The drawing has no text on it: only gates, measurements, neurons and weights.

The circuit follows the paper's Fig. 1, laid out left to right: an input perceptron feeds the first layer's gate angles (W⁰x); six hidden layers each run a column of two-qubit matchgates on alternating bonds, then measure each qubit with probability p = 0.5; the measured outcomes feed forward through Wˡ into the next layer's angles; and an output perceptron reads the last layer's outcomes.

- **When you send a message**, the band fades in. Between turns it is hidden.
- **Training**, while Claude thinks or runs tools, is drawn as the paper trains: REINFORCE. A burst of faint forward shots, each on its own sampled set of measured sites; the gates fill in brighter as they gather their local scores; the outputs flash as the shots are scored; then every weight and gate updates at once, each in a brighter shade of its own color. Nothing runs backward.
- **Feed-forward**, while Claude writes its answer, is one bright pulse from the inputs to the outputs, repeated while text streams, at the same speed as a training shot.
- **Every pass samples afresh**: each qubit is measured with probability p after each layer, drawn anew for every training shot and every feed-forward pulse.
- **When the turn ends**, one last full pass lights the output neurons, then the band fades out. An interrupted turn fades out at once.

`/minn` hides or shows the band. It draws on the desktop app, mobile and VS Code; the terminal gets a plain glyph version.

## bloch-spinner

A small Bloch sphere at the right end of a row above the prompt, holding one qubit that starts at |0⟩.

- **While Claude thinks or runs tools**, a random gate acts about once a second: H, X, Y, Z, S, T, √X, or a rotation Rx, Ry or Rz by π/4 to 2π/3. The vector turns about the gate's axis and leaves a short trail. A gate that would not move the vector, such as a Z rotation at a pole, is skipped.
- **When Claude starts writing its answer**, the qubit is measured. For |ψ⟩ = α|0⟩ + β|1⟩ the outcome is 0 with probability P(0) = |α|² = (1 + z)/2, where z is the vector's height, and 1 with P(1) = |β|². The vector slides along its meridian to that pole, a ring pulses where it lands, and the bit is shown beside the sphere.
- **The state collapses**: the bit stays until Claude thinks again, and the gates then start from the measured pole, in the next turn too.

It draws on the desktop app, mobile and VS Code; the terminal has no vector drawing, so it shows nothing there.

## Adding a mod

1. Put the mod's folder under `plugins/<mod>/`, with its `.claude-plugin/plugin.json`.
2. Add an entry for it to `.claude-plugin/marketplace.json`: its `name` (as in its `plugin.json`), `"source": "./plugins/<mod>"` and a one-line `description`.
3. Add a row to the table above, and check it with `claude plugin validate plugins/<mod>`.
