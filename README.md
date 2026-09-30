# Pi telemetry

This Pi extension records local, append-only JSONL telemetry at `~/.pi/agent/telemetry/pi-usage.jsonl`.

## Install

Clone this repository into Pi's user extension directory:

```bash
git clone git@github.com:akalpaki-coherentsolutions/pi-telemetry.git ~/.pi/agent/extensions/telemetry
```

Restart Pi or run `/reload`.

## Use

Run these commands inside Pi:

- `/telemetry` shows the current session.
- `/telemetry today` aggregates the latest snapshot for every session updated today.
- `/telemetry all` aggregates every recorded session.
- `/telemetry path` shows the data path.

Each snapshot has primary Pi model usage, usage from experiments, total input and output tokens, cache tokens, total cost, and AgentDiet's removed future input tokens. AgentDiet reflector calls count as experiment usage and cost. The removed tokens are not dollar savings. Pi only bills tokens that a later request sends.

Pi supplies normalized usage and cost from each model response, so OpenAI and OpenAI-compatible models work without a separate pricing table. The selected model must have Pi cost metadata for its cost to be nonzero.

## Instrument another experiment

An extension can report its own model call or measured saving through Pi's event bus:

```ts
pi.events.emit("telemetry:contribution", {
  id: crypto.randomUUID(),
  experiment: "my-experiment",
  usage: response.usage,
  savings: { inputTokens: 1200 },
  metadata: { variant: "control" },
});
```

`id` must be unique. Telemetry adds the contribution to the active session and writes a JSONL event. `savings.inputTokens` means future context removed, not billed dollars. Keep prompts, responses, tool output, API keys, and personal data out of `metadata`.

## Tests

```bash
./run-tests.sh
```

The unit tests run with stub Pi modules. If `tsc` and Pi's package directory are available, the script typechecks too. Set `PI_CODING_AGENT_PACKAGE_DIR` when Pi is installed outside the global npm directory.
