import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { addMetrics, createUsageTotals, isTelemetryContribution, type UsageTotals } from "./metrics.ts";

export type UsageRecord = {
  type: "usage_record";
  schemaVersion: 2;
  timestamp: string;
  sessionId: string;
  entryId: string;
  taskId: string;
  model: string;
  category: "primary" | "experiment" | "subagent";
  usage: UsageTotals;
  savedInputTokens: number;
};

type RecordData = Pick<UsageRecord, "timestamp" | "model" | "category" | "usage" | "savedInputTokens">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageTotals(usage: Usage): UsageTotals {
  return {
    input: finite(usage.input), output: finite(usage.output),
    cacheRead: finite(usage.cacheRead), cacheWrite: finite(usage.cacheWrite),
    cost: finite(usage.cost?.total),
  };
}

function hasUsage(value: unknown): value is Usage {
  return isRecord(value) && isRecord(value.cost) &&
    [value.input, value.output, value.cacheRead, value.cacheWrite, value.cost.total].every(
      (item) => typeof item === "number" && Number.isFinite(item),
    );
}

function iso(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return fallback;
}

function subagentRecords(details: unknown, fallback: string): RecordData[] {
  if (!isRecord(details) || !Array.isArray(details.results)) return [];
  const records: RecordData[] = [];
  for (const result of details.results) {
    if (!isRecord(result) || !Array.isArray(result.messages)) continue;
    for (const message of result.messages) {
      if (!isRecord(message)) continue;
      if (message.role === "toolResult" && message.toolName === "subagent" && !hasUsage(message.usage)) {
        records.push(...subagentRecords(message.details, iso(message.timestamp, fallback)));
      }
      if (message.role !== "assistant" || !hasUsage(message.usage)) continue;
      records.push({
        timestamp: iso(message.timestamp, fallback), model: `${typeof message.provider === "string" ? `${message.provider}/` : ""}${String(message.responseModel ?? message.model ?? result.model ?? "unknown")}`,
        category: "subagent", usage: usageTotals(message.usage), savedInputTokens: 0,
      });
    }
  }
  return records;
}

/** Read the complete session tree, including branches no longer selected. */
export function usageRecords(entries: readonly SessionEntry[], sessionId: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  const tasks = new Map<string, string>();
  for (const entry of entries) {
    const taskId = entry.type === "message" && entry.message.role === "user"
      ? entry.id : (entry.parentId ? tasks.get(entry.parentId) : undefined) ?? "unassigned";
    tasks.set(entry.id, taskId);
    const base = { type: "usage_record" as const, schemaVersion: 2 as const, sessionId, taskId, entryId: entry.id };
    const data: RecordData[] = [];
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant" && hasUsage(message.usage)) {
        data.push({ timestamp: iso(message.timestamp, entry.timestamp), model: `${message.provider}/${message.responseModel ?? message.model}`, category: "primary", usage: usageTotals(message.usage), savedInputTokens: 0 });
      } else if (message.role === "toolResult") {
        // This subagent tool does not attach nested usage to its tool result.
        // Do not count the children again if a future version supplies it.
        if (!hasUsage(message.usage) && message.toolName === "subagent") data.push(...subagentRecords(message.details, entry.timestamp));
        if (hasUsage(message.usage)) data.push({ timestamp: entry.timestamp, model: "tool", category: "primary", usage: usageTotals(message.usage), savedInputTokens: 0 });
      }
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      if (hasUsage(entry.usage)) data.push({ timestamp: entry.timestamp, model: entry.type === "usage" ? `${entry.provider}/${entry.model}` : "summary", category: "primary", usage: usageTotals(entry.usage), savedInputTokens: 0 });
    } else if (entry.type === "custom") {
      if (entry.customType === "pi-telemetry:contribution" && isTelemetryContribution(entry.data) && entry.data.usage) {
        data.push({ timestamp: iso(entry.data.timestamp, entry.timestamp), model: entry.data.experiment, category: "experiment", usage: usageTotals(entry.data.usage), savedInputTokens: 0 });
      } else if (entry.customType === "agentdiet" && isRecord(entry.data)) {
        const saved = Math.max(0, finite(entry.data.tokensBefore) - finite(entry.data.tokensAfter));
        if (hasUsage(entry.data.usage) || saved > 0) data.push({ timestamp: entry.timestamp, model: "AgentDiet reflector", category: "experiment", usage: hasUsage(entry.data.usage) ? usageTotals(entry.data.usage) : createUsageTotals(), savedInputTokens: saved });
      }
    }
    data.forEach((item, index) => records.push({ ...base, ...item, entryId: `${entry.id}:${index}` }));
  }
  return records;
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  if (!isRecord(value) || value.type !== "usage_record" || value.schemaVersion !== 2) return false;
  if (typeof value.sessionId !== "string" || typeof value.entryId !== "string" || typeof value.taskId !== "string" || typeof value.model !== "string" || typeof value.timestamp !== "string" || typeof value.category !== "string") return false;
  if (!["primary", "experiment", "subagent"].includes(value.category) || Number.isNaN(Date.parse(value.timestamp))) return false;
  if (!isRecord(value.usage)) return false;
  return [value.usage.input, value.usage.output, value.usage.cacheRead, value.usage.cacheWrite, value.usage.cost, value.savedInputTokens].every(
    (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
  );
}

export function recordsForDay(records: readonly UsageRecord[], day: Date): UsageRecord[] {
  const localDay = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = localDay(day);
  return records.filter((record) => localDay(new Date(record.timestamp)) === today);
}

export function recordTotals(records: readonly UsageRecord[]): { primary: UsageTotals; experiments: UsageTotals; subagents: UsageTotals; total: UsageTotals; savedInputTokens: number } {
  let primary = createUsageTotals();
  let experiments = createUsageTotals();
  let subagents = createUsageTotals();
  let savedInputTokens = 0;
  for (const record of records) {
    if (record.category === "primary") primary = addMetrics(primary, record.usage);
    else if (record.category === "subagent") subagents = addMetrics(subagents, record.usage);
    else experiments = addMetrics(experiments, record.usage);
    savedInputTokens += record.savedInputTokens;
  }
  return { primary, experiments, subagents, total: addMetrics(addMetrics(primary, experiments), subagents), savedInputTokens };
}
