import assert from "node:assert/strict";
import { collectMetrics } from "./metrics.ts";
import { usageRecords, recordTotals, recordsForDay, isUsageRecord } from "./ledger.ts";
import telemetry from "./index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  { type: "message", message: { role: "toolResult", usage: usage(2, 1, 0.003) } },
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
assert.deepEqual({ ...metrics.primary, cost: Number(metrics.primary.cost.toFixed(3)) }, { input: 167, output: 36, cacheRead: 12, cacheWrite: 8, cost: 0.022 });
assert.deepEqual(metrics.experiments, { input: 60, output: 10, cacheRead: 6, cacheWrite: 4, cost: 0.003 });
assert.deepEqual({ ...metrics.total, cost: Number(metrics.total.cost.toFixed(3)) }, { input: 227, output: 46, cacheRead: 18, cacheWrite: 12, cost: 0.025 });
assert.deepEqual(metrics.agentDiet, { events: 2, savedInputTokens: 900, reflectorCost: 0.002 });

const localTime = (day, hour, minute) => new Date(2025, 0, day, hour, minute);
const branchEntries = [
  { id: "task", parentId: null, timestamp: localTime(1, 23, 0).toISOString(), type: "message", message: { role: "user" } },
  { id: "a", parentId: "task", timestamp: localTime(1, 23, 10).toISOString(), type: "message", message: { role: "assistant", provider: "openai", model: "fast", timestamp: localTime(1, 23, 10).getTime(), usage: usage(10, 1, 0.01) } },
  { id: "b", parentId: "task", timestamp: localTime(2, 1, 0).toISOString(), type: "message", message: { role: "assistant", provider: "openai", model: "strong", timestamp: localTime(2, 1, 0).getTime(), usage: usage(20, 2, 0.02) } },
  { id: "child", parentId: "b", timestamp: localTime(2, 1, 10).toISOString(), type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ messages: [
    { role: "assistant", model: "child-model", timestamp: localTime(2, 1, 8).getTime(), usage: usage(30, 3, 0.03) },
  ] }] } } },
];
const recorded = usageRecords(branchEntries, "session-1");
assert.equal(recorded.length, 3);
assert.equal(recordTotals(recorded).total.cost, 0.06);
assert.equal(recordTotals(recordsForDay(recorded, new Date(2025, 0, 2))).total.cost, 0.05);
assert.deepEqual(recorded.map((row) => row.model), ["openai/fast", "openai/strong", "child-model"]);
assert.ok(recorded.every((row) => row.taskId === "task"));
assert.equal(isUsageRecord({ ...recorded[0], usage: { ...recorded[0].usage, cost: -1 } }), false);
assert.equal(isUsageRecord({ ...recorded[0], timestamp: "not a date" }), false);

const fork = [
  ...branchEntries,
  { id: "other-task", parentId: "a", timestamp: "2025-01-03T00:00:00Z", type: "message", message: { role: "user" } },
  { id: "other-answer", parentId: "other-task", timestamp: "2025-01-03T00:01:00Z", type: "message", message: { role: "assistant", provider: "openai", model: "fast", timestamp: Date.parse("2025-01-03T00:01:00Z"), usage: usage(5, 1, 0.005) } },
];
assert.equal(usageRecords(fork, "session-1").at(-1).taskId, "other-task");
const failedChild = structuredClone(branchEntries);
failedChild[3].message.details.results[0].exitCode = 1;
assert.equal(recordTotals(usageRecords(failedChild, "session-1")).subagents.cost, 0.03);
failedChild[3].message.details.results[0].messages.push({
  role: "toolResult", toolName: "subagent", details: { results: [{ messages: [
    { role: "assistant", model: "grandchild", timestamp: localTime(2, 1, 9).getTime(), usage: usage(4, 1, 0.006) },
  ] }] },
});
assert.equal(recordTotals(usageRecords(failedChild, "session-1")).subagents.cost, 0.036);

const handlers = new Map();
let command;
telemetry({
  on: (name, handler) => handlers.set(name, handler),
  events: { on() {} },
  registerCommand: (_name, value) => { command = value.handler; },
});
const output = [];
const ctx = {
  cwd: "/example",
  mode: "print",
  sessionManager: { getSessionId: () => "session-1", getEntries: () => branchEntries, getBranch: () => branchEntries },
  ui: { notify: (message) => { throw new Error(message); } },
};
handlers.get("agent_settled")({}, ctx);
handlers.get("agent_settled")({}, ctx);
const path = join(process.env.PI_TELEMETRY_TEST_DIR, "telemetry/pi-usage.jsonl");
const persisted = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
assert.equal(persisted.filter((row) => row.type === "usage_record").length, 3);
const log = console.log;
try {
  console.log = (text) => output.push(text);
  await command("all", ctx);
} finally { console.log = log; }
assert.match(output.join("\n"), /Subagents.*\$0\.0300/);
assert.match(output.join("\n"), /Total.*\$0\.0600/);

const childCtx = { ...ctx, sessionManager: {
  getSessionId: () => "child-session",
  getEntries: () => [
    { ...branchEntries[1], id: "child-model-call" },
    { id: "child-experiment", parentId: "child-model-call", type: "custom", customType: "agentdiet", timestamp: localTime(2, 1, 12).toISOString(), data: { usage: usage(3, 1, 0.004) } },
  ],
  getBranch: () => [],
} };
process.env.PI_TELEMETRY_DEFER_TO_PARENT = "1";
try { handlers.get("agent_settled")({}, childCtx); } finally { delete process.env.PI_TELEMETRY_DEFER_TO_PARENT; }
const afterChild = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse).filter((row) => row.sessionId === "child-session");
assert.deepEqual(afterChild.map((row) => row.category), ["experiment"]);
console.log("telemetry metrics, ledger, and persistence assertions passed");
