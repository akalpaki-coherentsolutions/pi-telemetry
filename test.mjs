import assert from "node:assert/strict";
import { collectMetrics } from "./index.ts";

const usage = (input, output, cost) => ({
  input,
  output,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: input + output + 5,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

const entries = [
  { type: "message", message: { role: "assistant", usage: usage(100, 20, 0.01) } },
  { type: "usage", usage: usage(40, 5, 0.004) },
  { type: "compaction", usage: usage(25, 10, 0.005) },
  {
    type: "custom",
    customType: "agentdiet",
    data: { tokensBefore: 1200, tokensAfter: 300, usage: usage(50, 8, 0.002) },
  },
  {
    type: "custom",
    customType: "pi-telemetry:contribution",
    data: { id: "experiment-1", experiment: "prompt-variant", usage: usage(10, 2, 0.001), savings: { inputTokens: 7 } },
  },
  { type: "custom", customType: "agentdiet", data: { tokensBefore: 10, tokensAfter: 20 } },
];

const metrics = collectMetrics(entries);
assert.deepEqual(metrics.primary, { input: 165, output: 35, cacheRead: 9, cacheWrite: 6, cost: 0.019 });
assert.deepEqual(metrics.experiments, { input: 60, output: 10, cacheRead: 6, cacheWrite: 4, cost: 0.003 });
assert.deepEqual(metrics.total, { input: 225, output: 45, cacheRead: 15, cacheWrite: 10, cost: 0.022 });
assert.deepEqual(metrics.agentDiet, { events: 2, savedInputTokens: 900, reflectorCost: 0.002 });

console.log("telemetry metrics: 4 assertions passed");
