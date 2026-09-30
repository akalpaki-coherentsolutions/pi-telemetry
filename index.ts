import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addMetrics,
	collectMetrics,
	createUsageTotals,
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

type StoredEvent = TelemetrySnapshot | ContributionEvent;

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
	const primary = createUsageTotals();
	const experiments = createUsageTotals();
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
		total: addMetrics(primary, experiments),
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
	});

	pi.on("agent_settled", (_event, ctx) => {
		persistSnapshot(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
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
		description: "Show locally stored Pi token and cost telemetry: session | today | all | path",
		handler: async (args, ctx) => {
			const scope = args.trim() || "session";
			if (scope === "path") {
				await show(ctx, ["Telemetry file", telemetryPath(), "JSONL snapshots contain no prompts or tool output."]);
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
