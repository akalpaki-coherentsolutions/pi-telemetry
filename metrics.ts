import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const CONTRIBUTION_ENTRY = "pi-telemetry:contribution";

export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export interface TelemetryContribution {
	id: string;
	experiment: string;
	timestamp?: string;
	usage?: Usage;
	savings?: { inputTokens: number };
	metadata?: Record<string, boolean | number | string>;
}

type AgentDietRecord = {
	tokensBefore?: number;
	tokensAfter?: number;
	track?: string;
	usage?: Usage;
};

export type SessionMetrics = {
	primary: UsageTotals;
	experiments: UsageTotals;
	total: UsageTotals;
	agentDiet: {
		events: number;
		savedInputTokens: number;
		reflectorCost: number;
	};
};

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += finite(usage.input);
	totals.output += finite(usage.output);
	totals.cacheRead += finite(usage.cacheRead);
	totals.cacheWrite += finite(usage.cacheWrite);
	totals.cost += finite(usage.cost?.total);
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function totalOf(primary: UsageTotals, experiments: UsageTotals): UsageTotals {
	return {
		input: primary.input + experiments.input,
		output: primary.output + experiments.output,
		cacheRead: primary.cacheRead + experiments.cacheRead,
		cacheWrite: primary.cacheWrite + experiments.cacheWrite,
		cost: primary.cost + experiments.cost,
	};
}

function isAssistant(entry: SessionEntry): entry is SessionEntry & { message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens, value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite, value.cost.total].every(
		(item) => typeof item === "number" && Number.isFinite(item),
	);
}

function isAgentDietRecord(value: unknown): value is AgentDietRecord {
	if (!isRecord(value)) return false;
	return (
		(value.tokensBefore === undefined || typeof value.tokensBefore === "number") &&
		(value.tokensAfter === undefined || typeof value.tokensAfter === "number") &&
		(value.track === undefined || typeof value.track === "string") &&
		(value.usage === undefined || isUsage(value.usage))
	);
}

export function isTelemetryContribution(value: unknown): value is TelemetryContribution {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.experiment !== "string" || value.experiment.length === 0) return false;
	if (value.timestamp !== undefined && typeof value.timestamp !== "string") return false;
	if (value.usage !== undefined && !isUsage(value.usage)) return false;
	if (value.savings !== undefined && (!isRecord(value.savings) || typeof value.savings.inputTokens !== "number")) return false;
	return value.metadata === undefined || (isRecord(value.metadata) && Object.values(value.metadata).every((item) => ["boolean", "number", "string"].includes(typeof item)));
}

/** Compute exact Pi-reported usage plus experiment usage stored in a session branch. */
export function collectMetrics(entries: readonly SessionEntry[]): SessionMetrics {
	const primary = emptyTotals();
	const experiments = emptyTotals();
	let dietEvents = 0;
	let dietSavedInputTokens = 0;
	let dietReflectorCost = 0;

	for (const entry of entries) {
		if (isAssistant(entry)) {
			addUsage(primary, entry.message.usage);
			continue;
		}
		if (entry.type === "usage") {
			addUsage(primary, entry.usage);
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(primary, entry.usage);
			continue;
		}
		if (entry.type !== "custom") continue;

		if (entry.customType === "agentdiet" && isAgentDietRecord(entry.data)) {
			const record = entry.data;
			const saved = finite(record.tokensBefore) - finite(record.tokensAfter);
			dietEvents += 1;
			dietSavedInputTokens += Math.max(0, saved);
			addUsage(experiments, record.usage);
			dietReflectorCost += finite(record.usage?.cost?.total);
			continue;
		}

		if (entry.customType === CONTRIBUTION_ENTRY && isTelemetryContribution(entry.data)) {
			addUsage(experiments, entry.data.usage);
		}
	}

	return {
		primary,
		experiments,
		total: totalOf(primary, experiments),
		agentDiet: {
			events: dietEvents,
			savedInputTokens: dietSavedInputTokens,
			reflectorCost: dietReflectorCost,
		},
	};
}

/** Return the prompt-cache read share of the latest assistant response. */
export function latestCacheHitRate(entries: readonly SessionEntry[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isAssistant(entry)) continue;

		const usage = entry.message.usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
	}
	return undefined;
}

export function formatAbsoluteTokens(tokens: number): string {
	return Math.round(tokens).toLocaleString("en-US");
}

export function addMetrics(primary: UsageTotals, experiments: UsageTotals): UsageTotals {
	return totalOf(primary, experiments);
}

export function createUsageTotals(): UsageTotals {
	return emptyTotals();
}
