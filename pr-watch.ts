// Canonical source: https://github.com/oleksoleksoleks/pr-watch-extension
// Edit the repo copy first, commit/push it, then run `npm run install:local` to update ~/.omp/agent/extensions/pr-watch.ts.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

interface PullRequestSummary {
	number: number;
	title: string;
	url: string;
	headRefName?: string;
	isDraft?: boolean;
	mergeStateStatus?: string;
	reviewDecision?: string;
	updatedAt?: string;
	statusCheckRollup?: CheckRollupItem[];
}

interface CheckRollupItem {
	__typename?: string;
	name?: string;
	workflowName?: string;
	status?: string;
	conclusion?: string;
	state?: string;
}

interface GhUser {
	login?: string;
}

interface GhComment {
	id: number;
	user?: GhUser;
	body?: string;
	html_url?: string;
	path?: string;
	line?: number;
	original_line?: number;
}

interface GhReview {
	id: number;
	user?: GhUser;
	body?: string;
	html_url?: string;
	state?: string;
}

interface WatchHit {
	key: string;
	pr: PullRequestSummary;
	kind: "issue comment" | "review comment" | "review";
	url: string;
	body: string;
	location?: string;
}

interface PullRequestReport {
	pr: PullRequestSummary;
	hits: WatchHit[];
	needs: string[];
	checkSummary: string;
	latestRoboomp: WatchHit | undefined;
}

interface WatchState {
	repo: string;
	prNumbers: number[] | undefined;
	interval: NodeJS.Timeout | undefined;
	intervalMs: number;
	seen: Set<string>;
	checking: boolean;
	lastCheckMs: number | undefined;
	lastError: string | undefined;
}

const TARGET_REQUIRED_MESSAGE = "No GitHub repository detected. Run /pr-watch start OWNER/REPO [PR_NUMBER] from a GitHub repository checkout.";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const ROBOOMP = "roboomp";
const PR_JSON_FIELDS = "number,title,url,headRefName,isDraft,mergeStateStatus,reviewDecision,updatedAt,statusCheckRollup";

interface ParsedTarget {
	explicitRepo: string | undefined;
	prNumbers: number[] | undefined;
	intervalMs: number;
}

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function parseIntervalMs(value: string | undefined): number {
	if (!value) return DEFAULT_INTERVAL_MS;
	const match = /^(\d+)(ms|s|m)?$/.exec(value.trim().toLowerCase());
	if (!match) return DEFAULT_INTERVAL_MS;
	const amount = Number(match[1]);
	const unit = match[2] ?? "m";
	if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_INTERVAL_MS;
	if (unit === "ms") return Math.max(1_000, amount);
	if (unit === "s") return Math.max(1_000, amount * 1000);
	return Math.max(1_000, amount * 60 * 1000);
}

function cleanToken(token: string): string {
	return token.replace(/^["']+|["']+$/g, "");
}

function parseRepoToken(token: string): string | undefined {
	const cleaned = cleanToken(token);
	const githubMatch = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s/]+)(?:\/|$)/.exec(cleaned);
	if (githubMatch) return `${githubMatch[1]}/${githubMatch[2]}`;
	return /^[^/\s]+\/[^/\s]+$/.test(cleaned) ? cleaned : undefined;
}

function parsePrNumberToken(token: string): number | undefined {
	const cleaned = cleanToken(token);
	if (/^\d+$/.test(cleaned)) return Number(cleaned);
	const prUrlMatch = /^https:\/\/github\.com\/[^/\s]+\/[^/\s/]+\/pull\/(\d+)(?:[#/?].*)?$/.exec(cleaned);
	return prUrlMatch ? Number(prUrlMatch[1]) : undefined;
}

function parseTargetTokens(tokens: string[]): ParsedTarget {
	let explicitRepo: string | undefined;
	let prNumbers: number[] | undefined;
	let intervalToken: string | undefined;

	for (const rawToken of tokens) {
		const token = cleanToken(rawToken);
		if (token === "/pr-watch" || token === "pr-watch" || token === "/repo-watch" || token === "repo-watch") {
			continue;
		}

		const prNumber = parsePrNumberToken(token);
		if (prNumber !== undefined) {
			prNumbers = [prNumber];
			continue;
		}

		const repoToken = parseRepoToken(token);
		if (repoToken) {
			explicitRepo = repoToken;
			continue;
		}

		intervalToken = token;
	}

	return { explicitRepo, prNumbers, intervalMs: parseIntervalMs(intervalToken) };
}

async function detectCurrentRepo(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	const result = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
		cwd: ctx.cwd,
		timeout: 10_000,
	});
	if (result.code !== 0) return undefined;
	const repo = result.stdout.trim();
	return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : undefined;
}

async function resolveTarget(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tokens: string[],
): Promise<{ repo: string; prNumbers: number[] | undefined; intervalMs: number }> {
	const parsed = parseTargetTokens(tokens);
	const repo = parsed.explicitRepo ?? (await detectCurrentRepo(pi, ctx));
	if (!repo) {
		throw new Error(TARGET_REQUIRED_MESSAGE);
	}
	return {
		repo,
		prNumbers: parsed.prNumbers,
		intervalMs: parsed.intervalMs,
	};
}

function excerpt(body: string): string {
	const oneLine = body.replace(/\s+/g, " ").trim();
	if (oneLine.length <= 180) return oneLine;
	return `${oneLine.slice(0, 177)}...`;
}

function ringTerminalBell(): void {
	try {
		process.stdout.write("\u0007");
	} catch {
		// Ignore non-interactive runtimes; ctx.ui.notify still carries the alert.
	}
}

async function ghJson<T>(pi: ExtensionAPI, args: string[]): Promise<T> {
	const result = await pi.exec("gh", args, { timeout: 30_000 });
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout || `gh exited ${result.code}`).trim();
		throw new Error(detail);
	}
	return JSON.parse(result.stdout) as T;
}

async function listPullRequests(
	pi: ExtensionAPI,
	repo: string,
	prNumbers: number[] | undefined,
): Promise<PullRequestSummary[]> {
	if (prNumbers) {
		const prs: PullRequestSummary[] = [];
		for (const number of prNumbers) {
			const pr = await ghJson<PullRequestSummary>(pi, [
				"pr",
				"view",
				String(number),
				"--repo",
				repo,
				"--json",
				PR_JSON_FIELDS,
			]);
			prs.push(pr);
		}
		return prs;
	}

	return ghJson<PullRequestSummary[]>(pi, [
		"pr",
		"list",
		"--repo",
		repo,
		"--state",
		"open",
		"--author",
		"@me",
		"--json",
		PR_JSON_FIELDS,
	]);
}

function checkCounts(pr: PullRequestSummary): { failed: number; pending: number; passed: number; total: number } {
	let failed = 0;
	let pending = 0;
	let passed = 0;
	for (const check of pr.statusCheckRollup ?? []) {
		const status = check.status?.toUpperCase();
		const conclusion = (check.conclusion ?? check.state)?.toUpperCase();
		if (status !== undefined && status !== "COMPLETED") {
			pending += 1;
			continue;
		}
		switch (conclusion) {
			case "SUCCESS":
			case "NEUTRAL":
			case "SKIPPED":
				passed += 1;
				break;
			case "PENDING":
			case "EXPECTED":
			case undefined:
			case "":
				pending += 1;
				break;
			default:
				failed += 1;
				break;
		}
	}
	return { failed, pending, passed, total: failed + pending + passed };
}

function summarizeChecks(pr: PullRequestSummary): string {
	const counts = checkCounts(pr);
	if (counts.total === 0) return "checks: none";
	const parts: string[] = [];
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	if (counts.pending > 0) parts.push(`${counts.pending} pending`);
	if (counts.passed > 0) parts.push(`${counts.passed} passed`);
	return `checks: ${parts.join(", ")}`;
}

function deriveNeeds(pr: PullRequestSummary, hits: readonly WatchHit[]): string[] {
	const needs: string[] = [];
	const counts = checkCounts(pr);
	if (pr.isDraft === true) needs.push("draft");
	if (pr.reviewDecision === "CHANGES_REQUESTED") needs.push("changes requested");
	if (counts.failed > 0) needs.push(`${counts.failed} failing check(s)`);
	else if (counts.pending > 0) needs.push(`${counts.pending} pending check(s)`);
	if (pr.mergeStateStatus === "DIRTY") needs.push("merge conflicts");
	if (pr.mergeStateStatus === "BEHIND") needs.push("branch behind");
	if (hits.length > 0) needs.push(`${hits.length} roboomp item(s)`);
	if (pr.reviewDecision === "REVIEW_REQUIRED") needs.push("maintainer review required");
	if (
		pr.mergeStateStatus === "BLOCKED" &&
		pr.reviewDecision !== "REVIEW_REQUIRED" &&
		counts.failed === 0 &&
		counts.pending === 0
	) {
		needs.push("repository merge requirements unmet");
	}
	return needs.length > 0 ? needs : ["no action needed"];
}

async function collectRoboompHitsForPr(
	pi: ExtensionAPI,
	repo: string,
	pr: PullRequestSummary,
): Promise<WatchHit[]> {
	const hits: WatchHit[] = [];
	const issueComments = await ghJson<GhComment[]>(pi, ["api", `repos/${repo}/issues/${pr.number}/comments`]);
	for (const comment of issueComments) {
		if (comment.user?.login !== ROBOOMP) continue;
		hits.push({
			key: `issue:${comment.id}`,
			pr,
			kind: "issue comment",
			url: comment.html_url ?? pr.url,
			body: comment.body ?? "",
		});
	}

	const reviewComments = await ghJson<GhComment[]>(pi, ["api", `repos/${repo}/pulls/${pr.number}/comments`]);
	for (const comment of reviewComments) {
		if (comment.user?.login !== ROBOOMP) continue;
		let location: string | undefined;
		if (comment.path) {
			const lineNum = comment.line ?? comment.original_line;
			location = lineNum ? `${comment.path}:${lineNum}` : comment.path;
		}
		hits.push({
			key: `review-comment:${comment.id}`,
			pr,
			kind: "review comment",
			url: comment.html_url ?? pr.url,
			body: comment.body ?? "",
			location,
		});
	}

	const reviews = await ghJson<GhReview[]>(pi, ["api", `repos/${repo}/pulls/${pr.number}/reviews`]);
	for (const review of reviews) {
		if (review.user?.login !== ROBOOMP) continue;
		hits.push({
			key: `review:${review.id}`,
			pr,
			kind: "review",
			url: review.html_url ?? pr.url,
			body: review.body ?? review.state ?? "review",
		});
	}

	return hits;
}

async function collectPullRequestReports(pi: ExtensionAPI, state: WatchState): Promise<PullRequestReport[]> {
	const prs = await listPullRequests(pi, state.repo, state.prNumbers);
	const reports: PullRequestReport[] = [];
	for (const pr of prs) {
		const hits = await collectRoboompHitsForPr(pi, state.repo, pr);
		reports.push({
			pr,
			hits,
			needs: deriveNeeds(pr, hits),
			checkSummary: summarizeChecks(pr),
			latestRoboomp: hits.at(-1),
		});
	}
	return reports;
}

async function collectRoboompHits(pi: ExtensionAPI, state: WatchState): Promise<WatchHit[]> {
	const reports = await collectPullRequestReports(pi, state);
	return reports.flatMap(report => report.hits);
}

function targetLabel(state: WatchState): string {
	return state.prNumbers ? `#${state.prNumbers.join(", #")}` : "open PRs authored by me";
}

function intervalLabel(intervalMs: number): string {
	if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
	if (intervalMs % 1000 === 0) return `${intervalMs / 1000}s`;
	return `${intervalMs}ms`;
}

function updatedLabel(value: string | undefined): string {
	if (!value) return "updated: unknown";
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) return `updated: ${value}`;
	const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
	if (minutes < 60) return `updated: ${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `updated: ${hours}h ago`;
	return `updated: ${Math.round(hours / 24)}d ago`;
}

function reportActionItems(report: PullRequestReport): string[] {
	const actions: string[] = [];
	const { pr } = report;
	const counts = checkCounts(pr);
	if (pr.isDraft === true) actions.push("draft");
	if (pr.reviewDecision === "CHANGES_REQUESTED") actions.push("changes requested");
	if (counts.failed > 0) actions.push(`${counts.failed} failing check(s)`);
	if (pr.mergeStateStatus === "DIRTY") actions.push("merge conflicts");
	if (pr.mergeStateStatus === "BEHIND") actions.push("update branch");
	if (report.hits.length > 0) actions.push(`${report.hits.length} roboomp item(s)`);
	return actions;
}

function reportWaitingItems(report: PullRequestReport): string[] {
	const waiting: string[] = [];
	const counts = checkCounts(report.pr);
	if (report.pr.reviewDecision === "REVIEW_REQUIRED") waiting.push("maintainer review required");
	if (counts.pending > 0) waiting.push(`${counts.pending} pending check(s)`);
	return waiting;
}

function reportBlockedItems(report: PullRequestReport): string[] {
	const counts = checkCounts(report.pr);
	if (
		report.pr.mergeStateStatus === "BLOCKED" &&
		report.pr.reviewDecision !== "REVIEW_REQUIRED" &&
		counts.failed === 0 &&
		counts.pending === 0
	) {
		return ["repository merge requirements unmet"];
	}
	return [];
}

function reportNeedsAttention(report: PullRequestReport): boolean {
	return reportActionItems(report).length > 0;
}

function formatActionStatus(report: PullRequestReport): { text: string; url: string | undefined } {
	const actions = reportActionItems(report);
	if (actions.length > 0) {
		return {
			text: `Action needed — ${actions.join("; ")}`,
			url: report.latestRoboomp?.url ?? report.pr.url,
		};
	}
	const waiting = reportWaitingItems(report);
	if (waiting.length > 0) {
		return {
			text: `Waiting — ${waiting.join("; ")}`,
			url: undefined,
		};
	}
	const blocked = reportBlockedItems(report);
	if (blocked.length > 0) {
		return {
			text: `Blocked — ${blocked.join("; ")}`,
			url: undefined,
		};
	}
	return { text: "No action needed", url: undefined };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

function formatReportLines(report: PullRequestReport): string[] {
	const { pr } = report;
	const status = formatActionStatus(report);
	const line = `#${pr.number} ${replaceTabs(pr.title)}: ${status.text}`;
	return status.url ? [`${line} — ${status.url}`] : [line];
}

function formatStatusLines(state: WatchState, reports: readonly PullRequestReport[]): string[] {
	const lastCheck = state.lastCheckMs ? new Date(state.lastCheckMs).toLocaleTimeString() : "never";
	const lines = [
		`PR Watch — ${state.interval ? `running every ${intervalLabel(state.intervalMs)}` : "stopped"}`,
		`Repo: ${state.repo}; target: ${targetLabel(state)}; last check: ${lastCheck}`,
	];
	if (state.lastError) lines.push(`Last error: ${state.lastError}`);
	if (reports.length === 0) {
		lines.push("No matching open PRs.");
		return lines;
	}

	for (const report of reports.slice(0, 8)) {
		lines.push(...formatReportLines(report));
	}
	if (reports.length > 8) lines.push("", `… ${reports.length - 8} more PR(s) omitted`);
	return lines;
}

async function showStatus(pi: ExtensionAPI, ctx: ExtensionContext, state: WatchState): Promise<void> {
	try {
		const reports = await collectPullRequestReports(pi, state);
		state.lastCheckMs = Date.now();
		state.lastError = undefined;
		ctx.ui.setWidget("pr-watch.status", formatStatusLines(state, reports), { placement: "aboveEditor" });
		const attentionCount = reports.filter(reportNeedsAttention).length;
		const type = attentionCount > 0 ? "warning" : "info";
		ctx.ui.notify(`PR watch: ${reports.length} PR(s), ${attentionCount} need attention`, type);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		state.lastError = message;
		ctx.ui.notify(`PR watch status failed: ${message}`, "error");
	}
}

async function checkNow(pi: ExtensionAPI, ctx: ExtensionContext, state: WatchState): Promise<number> {
	if (state.checking) return 0;
	state.checking = true;
	try {
		const hits = await collectRoboompHits(pi, state);
		let newCount = 0;
		for (const hit of hits) {
			if (state.seen.has(hit.key)) continue;
			state.seen.add(hit.key);
			newCount += 1;
			const locLabel = hit.location ? ` (${hit.location})` : "";
			ctx.ui.notify(
				`#${hit.pr.number} ${replaceTabs(hit.pr.title)}: Action needed — ${hit.kind}${locLabel}: ${excerpt(hit.body)} — ${hit.url}`,
				"warning",
			);
		}
		if (newCount > 0) {
			ringTerminalBell();
		}
		state.lastCheckMs = Date.now();
		state.lastError = undefined;
		return newCount;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		state.lastError = message;
		ctx.ui.notify(`PR watch failed: ${message}`, "error");
		return 0;
	} finally {
		state.checking = false;
	}
}

function stopState(state: WatchState | undefined): boolean {
	if (!state?.interval) return false;
	clearInterval(state.interval);
	state.interval = undefined;
	return true;
}

export default function prWatchExtension(pi: ExtensionAPI): void {
	pi.setLabel("PR Watch");
	const watches = new Map<string, WatchState>();

	async function getState(pi: ExtensionAPI, ctx: ExtensionContext, tokens: string[] = []): Promise<WatchState> {
		const key = sessionKey(ctx);
		let state = watches.get(key);
		if (!state) {
			const parsed = await resolveTarget(pi, ctx, tokens);
			state = {
				repo: parsed.repo,
				prNumbers: parsed.prNumbers,
				interval: undefined,
				intervalMs: parsed.intervalMs,
				seen: new Set<string>(),
				checking: false,
				lastCheckMs: undefined,
				lastError: undefined,
			};
			watches.set(key, state);
		}
		return state;
	}

	function stopAll(): void {
		for (const state of watches.values()) {
			stopState(state);
		}
		watches.clear();
	}

	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		const [command = "status", ...rest] = splitArgs(args);
		const key = sessionKey(ctx);

		try {
			if (command === "test-notif") {
				ringTerminalBell();
				ctx.ui.notify("PR watch test notification: terminal bell sent", "warning");
				return;
			}

			if (command === "start") {
				const parsed = await resolveTarget(pi, ctx, rest);
				let state = watches.get(key);
				if (!state) {
					state = {
						repo: parsed.repo,
						prNumbers: parsed.prNumbers,
						interval: undefined,
						intervalMs: parsed.intervalMs,
						seen: new Set<string>(),
						checking: false,
						lastCheckMs: undefined,
						lastError: undefined,
					};
					watches.set(key, state);
				} else {
					state.repo = parsed.repo;
					state.prNumbers = parsed.prNumbers;
					state.intervalMs = parsed.intervalMs;
					state.seen.clear();
					state.lastError = undefined;
				}
				stopState(state);
				state.interval = setInterval(() => {
					void checkNow(pi, ctx, state);
				}, state.intervalMs);
				ctx.ui.notify(
					`PR watch started for ${state.repo}${state.prNumbers ? ` #${state.prNumbers.join(", #")}` : " open PRs"} every ${intervalLabel(state.intervalMs)}`,
					"info",
				);
				await checkNow(pi, ctx, state);
				await showStatus(pi, ctx, state);
				return;
			}

			if (command === "stop") {
				const state = watches.get(key);
				ctx.ui.setWidget("pr-watch.status", undefined);
				ctx.ui.notify(stopState(state) ? "PR watch stopped" : "PR watch is not running", "info");
				return;
			}

			if (command === "check") {
				const state = await getState(pi, ctx, rest);
				const newCount = await checkNow(pi, ctx, state);
				await showStatus(pi, ctx, state);
				ctx.ui.notify(`PR watch check complete: ${newCount} new roboomp item(s)`, "info");
				return;
			}

			if (command === "status") {
				const state = await getState(pi, ctx, rest);
				await showStatus(pi, ctx, state);
				return;
			}

			ctx.ui.notify(
				"Usage: /pr-watch start [PR_NUMBER|OWNER/REPO] [INTERVAL: 30s|5m] | stop | status | check | test-notif",
				"warning",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`PR watch: ${message}`, "error");
		}
	};

	pi.registerCommand("pr-watch", {
		description: "Watch open PRs for roboomp feedback in this session",
		handler,
	});
	pi.registerCommand("repo-watch", {
		description: "Alias for /pr-watch",
		handler,
	});

	pi.on("session_before_switch", stopAll);
	pi.on("session_before_branch", stopAll);
	pi.on("session_shutdown", stopAll);
}
