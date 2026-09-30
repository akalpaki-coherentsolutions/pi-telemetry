import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isUsageRecord, recordTotals, recordsForDay, usageRecords, type UsageRecord } from "./ledger.ts";
import {
	collectMetrics,
	isTelemetryContribution,
	type SessionMetrics,
	type TelemetryContribution,
} from "./metrics.ts";

const TELEMETRY_EVENT = "telemetry:contribution";
const CONTRIBUTION_ENTRY = "pi-telemetry:contribution";
const SCHEMA_VERSION = 1;

export { collectMetrics } from "./metrics.ts";
export type { SessionMetrics, TelemetryContribution } from "./metrics.ts";

type TelemetrySnapshot = {
	type: "session_snapshot";
	schemaVersion: number;
	timestamp: string;
	sessionId: string;
	cwd: string;
	metrics: SessionMetrics;
};

type ContributionEvent = {
	type: "contribution";
	schemaVersion: number;
	timestamp: string;
	sessionId: string;
	contribution: TelemetryContribution;
};

type StoredEvent = TelemetrySnapshot | ContributionEvent | UsageRecord;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTotals(value: unknown): value is SessionMetrics["primary"] {
	return isRecord(value) && [value.input, value.output, value.cacheRead, value.cacheWrite, value.cost].every((item) => typeof item === "number" && Number.isFinite(item));
}

function isMetrics(value: unknown): value is SessionMetrics {
	if (!isRecord(value) || !isTotals(value.primary) || !isTotals(value.experiments) || !isTotals(value.total) || !isRecord(value.agentDiet)) return false;
	return [value.agentDiet.events, value.agentDiet.savedInputTokens, value.agentDiet.reflectorCost].every((item) => typeof item === "number" && Number.isFinite(item));
}

function isStoredEvent(value: unknown): value is StoredEvent {
	if (!isRecord(value) || typeof value.schemaVersion !== "number" || typeof value.timestamp !== "string" || typeof value.sessionId !== "string") return false;
	if (value.type === "usage_record") return isUsageRecord(value);
	if (value.type === "contribution") return isTelemetryContribution(value.contribution);
	return value.type === "session_snapshot" && typeof value.cwd === "string" && isMetrics(value.metrics);
}

function telemetryDir(): string {
	return join(getAgentDir(), "telemetry");
}

function telemetryPath(): string {
	return join(telemetryDir(), "pi-usage.jsonl");
}

function appendEvent(event: StoredEvent): void {
	mkdirSync(telemetryDir(), { recursive: true, mode: 0o700 });
	appendFileSync(telemetryPath(), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function snapshot(ctx: ExtensionContext): TelemetrySnapshot {
	return {
		type: "session_snapshot",
		schemaVersion: SCHEMA_VERSION,
		timestamp: new Date().toISOString(),
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		metrics: collectMetrics(ctx.sessionManager.getBranch()),
	};
}

function persistSnapshot(ctx: ExtensionContext): void {
	if (process.env.PI_TELEMETRY_DEFER_TO_PARENT === "1") return;
	try {
		appendEvent(snapshot(ctx));
	} catch (error) {
		console.error(`pi-telemetry: could not write ${telemetryPath()}: ${String(error)}`);
	}
}

function persistUsage(ctx: ExtensionContext): void {
	try {
		const seen = new Set(readEvents().filter(isUsageRecord).map((row) => `${row.sessionId}/${row.entryId}`));
		for (const record of usageRecords(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId())) {
			if (process.env.PI_TELEMETRY_DEFER_TO_PARENT === "1" && record.category !== "experiment") continue;
			const key = `${record.sessionId}/${record.entryId}`;
			if (seen.has(key)) continue;
			appendEvent(record);
			seen.add(key);
		}
	} catch (error) {
		console.error(`pi-telemetry: could not write usage records: ${String(error)}`);
	}
}

function readEvents(): StoredEvent[] {
	try {
		return readFileSync(telemetryPath(), "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					const event: unknown = JSON.parse(line);
					return isStoredEvent(event) ? [event] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function formatNumber(value: number): string {
	return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(Math.round(value));
}

function formatCost(value: number): string {
	return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function usageLines(title: string, records: readonly UsageRecord[]): string[] {
	const totals = recordTotals(records);
	return [
		title,
		`Primary       in ${formatNumber(totals.primary.input)}  out ${formatNumber(totals.primary.output)}  cache ${formatNumber(totals.primary.cacheRead + totals.primary.cacheWrite)}  ${formatCost(totals.primary.cost)}`,
		`Subagents     in ${formatNumber(totals.subagents.input)}  out ${formatNumber(totals.subagents.output)}  cache ${formatNumber(totals.subagents.cacheRead + totals.subagents.cacheWrite)}  ${formatCost(totals.subagents.cost)}`,
		`Experiments   in ${formatNumber(totals.experiments.input)}  out ${formatNumber(totals.experiments.output)}                         ${formatCost(totals.experiments.cost)}`,
		`Total         in ${formatNumber(totals.total.input)}  out ${formatNumber(totals.total.output)}  cache ${formatNumber(totals.total.cacheRead + totals.total.cacheWrite)}  ${formatCost(totals.total.cost)}`,
		`AgentDiet     ${formatNumber(totals.savedInputTokens)} future input tokens removed (not billed savings)`,
	];
}

function breakdown(records: readonly UsageRecord[], key: "model" | "taskId"): string[] {
	const groups = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const name = key === "taskId" ? `${record.sessionId.slice(0, 8)}/${record.taskId}` : record.model;
		groups.set(name, [...(groups.get(name) ?? []), record]);
	}
	return [...groups.entries()]
		.map(([name, items]) => ({ name, items, cost: recordTotals(items).total.cost }))
		.sort((a, b) => b.cost - a.cost)
		.slice(0, 15)
		.map(({ name, items, cost }) => `${name}  ${formatCost(cost)}  ${formatNumber(recordTotals(items).total.input)} in / ${formatNumber(recordTotals(items).total.output)} out`);
}

function localDay(iso: string): string {
	const date = new Date(iso);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

class TelemetryView {
	private readonly theme: Theme;
	private readonly lines: string[];
	private readonly done: () => void;

	constructor(theme: Theme, lines: string[], done: () => void) {
		this.theme = theme;
		this.lines = lines;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data.toLowerCase() === "q") this.done();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const border = "─";
		const output = [this.theme.fg("border", `╭${border.repeat(inner)}╮`)];
		for (const line of this.lines) {
			output.push(this.theme.fg("border", "│") + truncateToWidth(` ${line}`, inner, "...", true) + this.theme.fg("border", "│"));
		}
		output.push(this.theme.fg("border", `╰${border.repeat(inner)}╯`));
		return output;
	}
}

async function show(ctx: ExtensionContext, lines: string[]): Promise<void> {
	if (ctx.mode !== "tui") {
		console.log(lines.join("\n"));
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new TelemetryView(theme, lines, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: 92, maxHeight: 16 },
	});
}

export default function telemetry(pi: ExtensionAPI) {
	let currentSessionId: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
	});

	pi.on("agent_settled", (_event, ctx) => {
		persistUsage(ctx);
		persistSnapshot(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persistUsage(ctx);
		persistSnapshot(ctx);
		currentSessionId = undefined;
	});

	pi.events.on(TELEMETRY_EVENT, (raw) => {
		if (!isTelemetryContribution(raw)) {
			console.error("pi-telemetry: ignored invalid telemetry contribution");
			return;
		}
		pi.appendEntry(CONTRIBUTION_ENTRY, raw);
		if (!currentSessionId) return;
		try {
			appendEvent({
				type: "contribution",
				schemaVersion: SCHEMA_VERSION,
				timestamp: raw.timestamp ?? new Date().toISOString(),
				sessionId: currentSessionId,
				contribution: raw,
			});
		} catch (error) {
			console.error(`pi-telemetry: could not write contribution: ${String(error)}`);
		}
	});

	pi.registerCommand("telemetry", {
		description: "Show Pi usage: session | today | all | models | tasks | path",
		handler: async (args, ctx) => {
			const scope = args.trim() || "session";
			if (scope === "path") {
				await show(ctx, ["Telemetry file", telemetryPath(), "JSONL records contain no prompts or tool output."]);
				return;
			}
			if (!["session", "today", "all", "models", "tasks"].includes(scope)) {
				ctx.ui.notify("Usage: /telemetry [session|today|all|models|tasks|path]", "error");
				return;
			}
			persistUsage(ctx);
			const today = localDay(new Date().toISOString());
			const stored = readEvents().filter(isUsageRecord);
			const records = scope === "all" ? stored : scope === "session"
				? stored.filter((item) => item.sessionId === ctx.sessionManager.getSessionId())
				: recordsForDay(stored, new Date());
			const lines = scope === "models" || scope === "tasks"
				? [`${scope === "models" ? "Models" : "Tasks"} today ${today}`, ...breakdown(records, scope === "models" ? "model" : "taskId")]
				: usageLines(scope === "session" ? `Session ${ctx.sessionManager.getSessionId().slice(0, 8)}` : scope === "today" ? `Today ${today}` : "All recorded usage", records);
			lines.push("Only scanned sessions appear here. Reopen an older session to backfill its recorded usage.");
			lines.push(`File: ${telemetryPath()}`);
			await show(ctx, lines);
		},
	});
}
