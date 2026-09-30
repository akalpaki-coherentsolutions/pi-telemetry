# Pi telemetry

This Pi extension records local, append-only JSONL telemetry at `~/.pi/agent/telemetry/pi-usage.jsonl`.

It exposes pure helpers in `metrics.ts` for cumulative input and output, cache reads, cache-hit rate, and AgentDiet contributions. The Status Bar extension uses those helpers to render Pi's footer.

## Install

Clone this repository into Pi's user extension directory:

```bash
git clone git@github.com:akalpaki-coherentsolutions/pi-telemetry.git ~/.pi/agent/extensions/telemetry
```

Restart Pi or run `/reload`.

## Use

Run these commands inside Pi:

- `/telemetry` shows all recorded usage in the current session, including abandoned branches.
- `/telemetry today` totals requests made today in your local time zone, not lifetime totals of sessions active today.
- `/telemetry all` totals all indexed requests.
- `/telemetry models` groups today's requests by model.
- `/telemetry tasks` groups today's requests by user-message ID, without storing the prompt.
- `/telemetry path` shows the data path.

Usage records are indexed from the full session tree on each settled run, shutdown, or telemetry command. Reopening an older session indexes its history. Untouched older sessions with only legacy snapshots are not included in the new totals. Existing snapshots remain in the JSONL file for older consumers. Repeated scans do not duplicate usage. Standalone Pi processes whose sessions are never scanned are not included.

Subagent responses in tool-result details count separately from the parent, even when the child failed. Nested responses are indexed recursively. To avoid counting the same model call in both processes, set `PI_TELEMETRY_DEFER_TO_PARENT=1` in the child environment when spawning Pi:

```ts
env: { ...process.env, PI_TELEMETRY_DEFER_TO_PARENT: "1" },
```

Without the marker, `/telemetry all` double-counts child responses. Child-side experiment usage is still recorded, but is not attributed to the parent task.

Usage includes primary Pi model requests, subagents, experiments, cache tokens, and cost. AgentDiet reflector calls count as experiment usage and cost. Removed future input tokens are not dollar savings. Task grouping uses the nearest user message on the session branch; it is a proxy for a task, not a measure of successful completion.

Pi supplies normalized usage and estimated cost from each model response, so OpenAI and OpenAI-compatible models work without a separate pricing table. The selected model must have Pi cost metadata for its cost to be nonzero. Subscription charges, taxes, discounts, and external API calls are not represented. Reconcile against provider billing for actual spend.

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
