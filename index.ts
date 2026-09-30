import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TELEMETRY_EVENT = "telemetry:contribution";
const CONTRIBUTION_ENTRY = "pi-telemetry:contribution";
const SCHEMA_VERSION = 1;

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

/**
 * A model call or measured saving reported by another Pi extension.
 *
 * Emit it with `pi.events.emit("telemetry:contribution", contribution)`. `id` must
 * be unique for the contribution. Savings describe removed future input context, not
 * money saved, because a token only becomes billable if Pi would have sent it.
 */
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

type StoredEvent = TelemetrySnapshot | ContributionEvent;

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

function isContribution(value: unknown): value is TelemetryContribution {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.experiment !== "string" || value.experiment.length === 0) return false;
	if (value.timestamp !== undefined && typeof value.timestamp !== "string") return false;
	if (value.usage !== undefined && !isUsage(value.usage)) return false;
	if (value.savings !== undefined && (!isRecord(value.savings) || typeof value.savings.inputTokens !== "number")) return false;
	return value.metadata === undefined || (isRecord(value.metadata) && Object.values(value.metadata).every((item) => ["boolean", "number", "string"].includes(typeof item)));
}

function isTotals(value: unknown): value is UsageTotals {
	return isRecord(value) && [value.input, value.output, value.cacheRead, value.cacheWrite, value.cost].every((item) => typeof item === "number" && Number.isFinite(item));
}

function isMetrics(value: unknown): value is SessionMetrics {
	if (!isRecord(value) || !isTotals(value.primary) || !isTotals(value.experiments) || !isTotals(value.total) || !isRecord(value.agentDiet)) return false;
	return [value.agentDiet.events, value.agentDiet.savedInputTokens, value.agentDiet.reflectorCost].every((item) => typeof item === "number" && Number.isFinite(item));
}

function isStoredEvent(value: unknown): value is StoredEvent {
	if (!isRecord(value) || typeof value.schemaVersion !== "number" || typeof value.timestamp !== "string" || typeof value.sessionId !== "string") return false;
	if (value.type === "contribution") return isContribution(value.contribution);
	return value.type === "session_snapshot" && typeof value.cwd === "string" && isMetrics(value.metrics);
}

/** Compute exact Pi-reported usage plus experiment usage stored in the active branch. */
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

		if (entry.customType === CONTRIBUTION_ENTRY && isContribution(entry.data)) {
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
	try {
		appendEvent(snapshot(ctx));
	} catch (error) {
		console.error(`pi-telemetry: could not write ${telemetryPath()}: ${String(error)}`);
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

function metricsLines(title: string, metrics: SessionMetrics): string[] {
	const { primary, experiments, total, agentDiet } = metrics;
	return [
		title,
		`Primary       in ${formatNumber(primary.input)}  out ${formatNumber(primary.output)}  cache ${formatNumber(primary.cacheRead + primary.cacheWrite)}  ${formatCost(primary.cost)}`,
		`Experiments   in ${formatNumber(experiments.input)}  out ${formatNumber(experiments.output)}                         ${formatCost(experiments.cost)}`,
		`Total         in ${formatNumber(total.input)}  out ${formatNumber(total.output)}  cache ${formatNumber(total.cacheRead + total.cacheWrite)}  ${formatCost(total.cost)}`,
		`AgentDiet     ${agentDiet.events} events, ${formatNumber(agentDiet.savedInputTokens)} future input tokens removed, reflector ${formatCost(agentDiet.reflectorCost)}`,
	];
}

function aggregate(snapshots: readonly TelemetrySnapshot[]): SessionMetrics {
	const primary = emptyTotals();
	const experiments = emptyTotals();
	let dietEvents = 0;
	let dietSavedInputTokens = 0;
	let dietReflectorCost = 0;
	for (const snapshot of snapshots) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
			primary[key] += snapshot.metrics.primary[key];
			experiments[key] += snapshot.metrics.experiments[key];
		}
		dietEvents += snapshot.metrics.agentDiet.events;
		dietSavedInputTokens += snapshot.metrics.agentDiet.savedInputTokens;
		dietReflectorCost += snapshot.metrics.agentDiet.reflectorCost;
	}
	return {
		primary,
		experiments,
		total: totalOf(primary, experiments),
		agentDiet: { events: dietEvents, savedInputTokens: dietSavedInputTokens, reflectorCost: dietReflectorCost },
	};
}

function latestSnapshots(events: readonly StoredEvent[], filter: (snapshot: TelemetrySnapshot) => boolean): TelemetrySnapshot[] {
	const latest = new Map<string, TelemetrySnapshot>();
	for (const event of events) {
		if (event.type !== "session_snapshot" || !filter(event)) continue;
		const previous = latest.get(event.sessionId);
		if (!previous || previous.timestamp < event.timestamp) latest.set(event.sessionId, event);
	}
	return [...latest.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
		const total = collectMetrics(ctx.sessionManager.getBranch()).total;
		ctx.ui.setStatus("telemetry", `↑${formatNumber(total.input)} ↓${formatNumber(total.output)} ${formatCost(total.cost)}`);
	});

	pi.on("agent_settled", (_event, ctx) => {
		persistSnapshot(ctx);
		const total = collectMetrics(ctx.sessionManager.getBranch()).total;
		ctx.ui.setStatus("telemetry", `↑${formatNumber(total.input)} ↓${formatNumber(total.output)} ${formatCost(total.cost)}`);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persistSnapshot(ctx);
		currentSessionId = undefined;
	});

	pi.events.on(TELEMETRY_EVENT, (raw) => {
		if (!isContribution(raw)) {
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
		description: "Show locally stored Pi token and cost telemetry: session | today | all | path",
		handler: async (args, ctx) => {
			const scope = args.trim() || "session";
			if (scope === "path") {
				await show(ctx, [`Telemetry file`, telemetryPath(), "JSONL snapshots contain no prompts or tool output."]);
				return;
			}
			if (scope === "session") {
				await show(ctx, [...metricsLines(`Session ${ctx.sessionManager.getSessionId().slice(0, 8)}`, collectMetrics(ctx.sessionManager.getBranch())), "Esc, Enter, or q closes this view."]);
				return;
			}
			if (scope !== "today" && scope !== "all") {
				ctx.ui.notify("Usage: /telemetry [session|today|all|path]", "error");
				return;
			}

			const today = localDay(new Date().toISOString());
			const snapshots = latestSnapshots(readEvents(), (item) => scope === "all" || localDay(item.timestamp) === today);
			const lines = metricsLines(`${scope === "today" ? `Today ${today}` : "All recorded sessions"} (${snapshots.length} sessions)`, aggregate(snapshots));
			lines.push(`File: ${telemetryPath()}`);
			lines.push("Esc, Enter, or q closes this view.");
			await show(ctx, lines);
		},
	});
}
