import { existsSync, statSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let Editor: any;
let Key: any;
let Text: any;
let Type: any;
let matchesKey: ((data: string, key: any) => boolean) | undefined;
let truncateToWidth: ((text: string, width: number) => string) | undefined;
let wrapTextWithAnsi: ((text: string, width: number) => string[]) | undefined;
let CURSOR_MARKER = "";

interface CollectedSecret {
	key: string;
	value: string | null;
}

interface ToolResultDetails {
	destination: string;
	environment?: string;
	applied: string[];
	skipped: string[];
	existingSkipped?: string[];
	detectedDestination?: string;
}

interface ExtensionUIContext {
	notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
	custom<T>(
		factory: (
			tui: any,
			theme: any,
			keybindings: any,
			done: (result: T) => void,
		) => any,
	): Promise<T | undefined>;
}

interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
}

interface ExtensionAPI {
	exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ code: number; stderr: string; stdout: string }>;
	registerTool(tool: any): void;
}

type SecretsManifestEntryStatus = "pending" | "collected" | "skipped";

interface SecretsManifestEntry {
	key: string;
	service: string;
	dashboardUrl: string;
	guidance: string[];
	formatHint: string;
	status: SecretsManifestEntryStatus;
	destination: string;
}

interface SecretsManifest {
	milestone: string;
	generatedAt: string;
	entries: SecretsManifestEntry[];
}

async function loadDeps(): Promise<void> {
	if (Editor && Type && Text) return;
	const tui = await import("@mariozechner/pi-tui");
	const typebox = await import("@sinclair/typebox");
	Editor = tui.Editor;
	Key = tui.Key;
	Text = tui.Text;
	matchesKey = tui.matchesKey;
	truncateToWidth = tui.truncateToWidth;
	wrapTextWithAnsi = tui.wrapTextWithAnsi;
	CURSOR_MARKER = tui.CURSOR_MARKER ?? "";
	Type = typebox.Type;
}

function maskPreview(value: string): string {
	if (!value) return "";
	if (value.length <= 8) return "*".repeat(value.length);
	return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function shellEscapeSingle(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeError(msg: string): string {
	const patterns = [
		/xoxb-[A-Za-z0-9\-]+/g,
		/xoxp-[A-Za-z0-9\-]+/g,
		/xoxa-[A-Za-z0-9\-]+/g,
		/\d{8,10}:[A-Za-z0-9_-]{35}/g,
		/[A-Za-z0-9_\-.]{20,}/g,
	];
	let sanitized = msg;
	for (const pattern of patterns) sanitized = sanitized.replace(pattern, "[REDACTED]");
	return sanitized;
}

function maskEditorLine(line: string): string {
	if (line.startsWith("─")) return line;
	let output = "";
	let i = 0;
	while (i < line.length) {
		if (CURSOR_MARKER && line.startsWith(CURSOR_MARKER, i)) {
			output += CURSOR_MARKER;
			i += CURSOR_MARKER.length;
			continue;
		}
		const ansiMatch = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
		if (ansiMatch) {
			output += ansiMatch[0];
			i += ansiMatch[0].length;
			continue;
		}
		const ch = line[i] as string;
		output += ch === " " ? " " : "*";
		i += 1;
	}
	return output;
}

function hydrateProcessEnv(key: string, value: string): void {
	process.env[key] = value;
}

async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
	let content = "";
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		content = "";
	}
	const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");
	const line = `${key}=${escaped}`;
	const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
	if (regex.test(content)) content = content.replace(regex, line);
	else {
		if (content.length > 0 && !content.endsWith("\n")) content += "\n";
		content += `${line}\n`;
	}
	await writeFile(filePath, content, "utf8");
}

export async function checkExistingEnvKeys(keys: string[], envFilePath: string): Promise<string[]> {
	let fileContent = "";
	try {
		fileContent = await readFile(envFilePath, "utf8");
	} catch {}
	const existing: string[] = [];
	for (const key of keys) {
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`^${escaped}\\s*=`, "m");
		if (regex.test(fileContent) || key in process.env) existing.push(key);
	}
	return existing;
}

export function detectDestination(basePath: string): "dotenv" | "vercel" | "convex" {
	if (existsSync(resolve(basePath, "vercel.json"))) return "vercel";
	const convexPath = resolve(basePath, "convex");
	try {
		if (existsSync(convexPath) && statSync(convexPath).isDirectory()) return "convex";
	} catch {}
	return "dotenv";
}

async function withTempSecretFile<T>(value: string, fn: (path: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-secure-env-"));
	const filePath = join(dir, "secret.txt");
	try {
		await writeFile(filePath, value, "utf8");
		return await fn(filePath);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function collectOneSecret(
	ctx: { ui: ExtensionUIContext; hasUI: boolean },
	pageIndex: number,
	totalPages: number,
	keyName: string,
	hint: string | undefined,
	guidance?: string[],
): Promise<string | null> {
	if (!ctx.hasUI) return null;
	await loadDeps();

	const result = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (r: string | null | undefined) => void) => {
		let cachedLines: string[] | undefined;
		const editor = new Editor(
			tui,
			{
				borderColor: (s: string) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			},
			{ paddingX: 1 },
		);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (matchesKey?.(data, Key.enter)) {
				const value = editor.getText().trim();
				done(value.length > 0 ? value : null);
				return;
			}
			if (matchesKey?.(data, Key.escape) || data === "\x13") {
				done(null);
				return;
			}
			editor.handleInput(data);
			refresh();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth ? truncateToWidth(s, width) : s.slice(0, width));

			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("dim", ` Page ${pageIndex + 1}/${totalPages} · Secure Env Setup`));
			lines.push("");
			add(theme.fg("accent", theme.bold(` ${keyName}`)));
			if (hint) add(theme.fg("muted", `  ${hint}`));

			if (guidance && guidance.length > 0) {
				lines.push("");
				for (let g = 0; g < guidance.length; g++) {
					const prefix = `  ${g + 1}. `;
					const wrapped = wrapTextWithAnsi ? wrapTextWithAnsi(guidance[g] as string, width - 4) : [guidance[g] as string];
					for (let w = 0; w < wrapped.length; w++) {
						const indent = w === 0 ? prefix : " ".repeat(prefix.length);
						lines.push(theme.fg("dim", `${indent}${wrapped[w]}`));
					}
				}
			}

			lines.push("");
			const raw = editor.getText();
			const preview = raw.length > 0 ? maskPreview(raw) : theme.fg("dim", "(empty — press enter to skip)");
			add(theme.fg("text", `  Preview: ${preview}`));
			lines.push("");
			add(theme.fg("muted", " Enter value:"));
			for (const line of editor.render(width - 2)) add(theme.fg("text", maskEditorLine(line)));
			lines.push("");
			add(theme.fg("dim", " enter to confirm  |  ctrl+s or esc to skip "));
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	if (result !== undefined) return result;
	ctx.ui.notify(`Secure input UI unavailable for ${keyName}; skipping to avoid plaintext secret entry.`, "warning");
	return null;
}

export const collectOneSecretWithGuidance = collectOneSecret;

export async function showSecretsSummary(
	ctx: { ui: ExtensionUIContext; hasUI: boolean },
	entries: SecretsManifestEntry[],
	existingKeys: string[],
): Promise<void> {
	if (!ctx.hasUI) return;
	const lines = ["Secrets Summary"];
	const existingSet = new Set(existingKeys);
	for (const entry of entries) {
		if (existingSet.has(entry.key)) lines.push(`✓ ${entry.key} (already set)`);
		else if (entry.status === "collected") lines.push(`✓ ${entry.key}`);
		else if (entry.status === "skipped") lines.push(`• ${entry.key} (skipped)`);
		else lines.push(`○ ${entry.key} (pending)`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function applySecrets(
	provided: Array<{ key: string; value: string }>,
	destination: "dotenv" | "vercel" | "convex",
	opts: {
		envFilePath: string;
		environment?: string;
		exec?: (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>;
	},
): Promise<{ applied: string[]; errors: string[] }> {
	const applied: string[] = [];
	const errors: string[] = [];

	if (destination === "dotenv") {
		for (const { key, value } of provided) {
			try {
				await writeEnvKey(opts.envFilePath, key, value);
				applied.push(key);
				hydrateProcessEnv(key, value);
			} catch (err: any) {
				errors.push(`${key}: ${sanitizeError(err.message)}`);
			}
		}
	}

	if ((destination === "vercel" || destination === "convex") && opts.exec) {
		const env = opts.environment ?? "development";
		for (const { key, value } of provided) {
			try {
				await withTempSecretFile(value, async (secretPath) => {
					const cmd = destination === "vercel"
						? `vercel env add ${key} ${env} < ${shellEscapeSingle(secretPath)}`
						: `npx convex env set ${key} "$(cat ${shellEscapeSingle(secretPath)})"`;
					const result = await opts.exec!("sh", ["-c", cmd]);
					if (result.code !== 0) errors.push(`${key}: ${sanitizeError(result.stderr.slice(0, 200))}`);
					else {
						applied.push(key);
						hydrateProcessEnv(key, value);
					}
				});
			} catch (err: any) {
				errors.push(`${key}: ${sanitizeError(err.message)}`);
			}
		}
	}

	return { applied, errors };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBoldField(text: string, key: string): string | null {
	const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, "m");
	const match = regex.exec(text);
	return match ? match[1].trim() : null;
}

function extractAllSections(body: string, level = 3): Map<string, string> {
	const prefix = `${"#".repeat(level)} `;
	const regex = new RegExp(`^${prefix}(.+)$`, "gm");
	const sections = new Map<string, string>();
	const matches = [...body.matchAll(regex)];
	for (let i = 0; i < matches.length; i++) {
		const heading = matches[i]?.[1]?.trim() ?? "";
		const start = (matches[i]?.index ?? 0) + (matches[i]?.[0]?.length ?? 0);
		const end = i + 1 < matches.length ? (matches[i + 1]?.index ?? body.length) : body.length;
		sections.set(heading, body.slice(start, end).trim());
	}
	return sections;
}

const VALID_STATUSES = new Set<SecretsManifestEntryStatus>(["pending", "collected", "skipped"]);

export function parseSecretsManifest(content: string): SecretsManifest {
	const milestone = extractBoldField(content, "Milestone") || "";
	const generatedAt = extractBoldField(content, "Generated") || "";
	const h3Sections = extractAllSections(content, 3);
	const entries: SecretsManifestEntry[] = [];
	for (const [heading, sectionContent] of h3Sections) {
		const key = heading.trim();
		if (!key) continue;
		const service = extractBoldField(sectionContent, "Service") || "";
		const dashboardUrl = extractBoldField(sectionContent, "Dashboard") || "";
		const formatHint = extractBoldField(sectionContent, "Format hint") || "";
		const rawStatus = ((extractBoldField(sectionContent, "Status") || "pending").toLowerCase().trim()) as SecretsManifestEntryStatus;
		const status = VALID_STATUSES.has(rawStatus) ? rawStatus : "pending";
		const destination = extractBoldField(sectionContent, "Destination") || "dotenv";
		const guidance: string[] = [];
		for (const line of sectionContent.split("\n")) {
			const numMatch = line.match(/^\s*\d+\.\s+(.+)/);
			if (numMatch) guidance.push(numMatch[1].trim());
		}
		entries.push({ key, service, dashboardUrl, guidance, formatHint, status, destination });
	}
	return { milestone, generatedAt, entries };
}

export function formatSecretsManifest(manifest: SecretsManifest): string {
	const lines: string[] = ["# Secrets Manifest", "", `**Milestone:** ${manifest.milestone}`, `**Generated:** ${manifest.generatedAt}`];
	for (const entry of manifest.entries) {
		lines.push("", `### ${entry.key}`, "", `**Service:** ${entry.service}`);
		if (entry.dashboardUrl) lines.push(`**Dashboard:** ${entry.dashboardUrl}`);
		if (entry.formatHint) lines.push(`**Format hint:** ${entry.formatHint}`);
		lines.push(`**Status:** ${entry.status}`, `**Destination:** ${entry.destination}`, "");
		for (let i = 0; i < entry.guidance.length; i++) lines.push(`${i + 1}. ${entry.guidance[i]}`);
	}
	return `${lines.join("\n")}\n`;
}

function resolveProjectStateRoot(basePath: string): string {
	let current = resolve(basePath);
	while (true) {
		if (existsSync(join(current, ".pi"))) return join(current, ".pi");
		if (existsSync(join(current, ".lsd"))) return join(current, ".lsd");
		if (existsSync(join(current, ".gsd"))) return join(current, ".gsd");
		const parent = resolve(current, "..");
		if (parent === current) return join(resolve(basePath), ".pi");
		current = parent;
	}
}

export function resolveMilestoneFile(basePath: string, milestoneId: string, suffix: string): string | null {
	const root = resolveProjectStateRoot(basePath);
	const milestonesDir = join(root, "milestones");
	if (!existsSync(milestonesDir)) return null;
	const directDir = join(milestonesDir, milestoneId);
	const candidateDirs = existsSync(directDir) ? [milestoneId] : [];
	if (candidateDirs.length === 0) {
		try {
			for (const entry of readdirSync(milestonesDir, { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name.startsWith(milestoneId)) candidateDirs.push(entry.name);
			}
		} catch {}
	}
	const dirName = candidateDirs[0];
	if (!dirName) return null;
	const dir = join(milestonesDir, dirName);
	const directFile = join(dir, `${milestoneId}-${suffix}.md`);
	if (existsSync(directFile)) return directFile;
	try {
		const file = readdirSync(dir).find((name) => name.startsWith(`${milestoneId}-`) && name.endsWith(`-${suffix}.md`));
		return file ? join(dir, file) : null;
	} catch {
		return null;
	}
}

export async function collectSecretsFromManifest(
	base: string,
	milestoneId: string,
	ctx: { ui: ExtensionUIContext; hasUI: boolean; cwd: string },
): Promise<{ applied: string[]; skipped: string[]; existingSkipped: string[] }> {
	const manifestPath = resolveMilestoneFile(base, milestoneId, "SECRETS");
	if (!manifestPath) throw new Error(`Secrets manifest not found for milestone ${milestoneId} in ${base}`);
	const content = await readFile(manifestPath, "utf8");
	const manifest = parseSecretsManifest(content);
	const envPath = resolve(base, ".env");
	const allKeys = manifest.entries.map((entry) => entry.key);
	const existingKeys = await checkExistingEnvKeys(allKeys, envPath);
	const existingSet = new Set(existingKeys);
	const existingSkipped: string[] = [];
	const alreadySkipped: string[] = [];
	const pendingEntries: SecretsManifestEntry[] = [];

	for (const entry of manifest.entries) {
		if (existingSet.has(entry.key)) existingSkipped.push(entry.key);
		else if (entry.status === "skipped") alreadySkipped.push(entry.key);
		else if (entry.status === "pending") pendingEntries.push(entry);
	}

	await showSecretsSummary(ctx, manifest.entries, existingKeys);

	const destination = detectDestination(ctx.cwd);
	const collected: CollectedSecret[] = [];
	for (let i = 0; i < pendingEntries.length; i++) {
		const entry = pendingEntries[i] as SecretsManifestEntry;
		const value = await collectOneSecret(ctx, i, pendingEntries.length, entry.key, entry.formatHint || undefined, entry.guidance.length > 0 ? entry.guidance : undefined);
		collected.push({ key: entry.key, value });
	}

	for (const { key, value } of collected) {
		const entry = manifest.entries.find((candidate) => candidate.key === key);
		if (entry) entry.status = value != null ? "collected" : "skipped";
	}

	await writeFile(manifestPath, formatSecretsManifest(manifest), "utf8");

	const provided = collected.filter((entry): entry is { key: string; value: string } => entry.value != null);
	const { applied } = await applySecrets(provided, destination, {
		envFilePath: resolve(ctx.cwd, ".env"),
	});
	const skipped = [...alreadySkipped, ...collected.filter((entry) => entry.value == null).map((entry) => entry.key)];
	return { applied, skipped, existingSkipped };
}

export default async function secureEnv(pi: ExtensionAPI) {
	await loadDeps();

	pi.registerTool({
		name: "secure_env_collect",
		label: "Secure Env Collect",
		description: "Collect one or more env vars through a paged masked-input UI, then write them to .env, Vercel, or Convex. Values are shown masked to the user and never echoed in tool output.",
		promptSnippet: "Collect and apply env vars securely without asking user to edit files manually.",
		promptGuidelines: [
			"NEVER ask the user to manually edit .env files, copy-paste into a terminal, or open a dashboard to set env vars. Always use secure_env_collect instead.",
			"When a command fails due to a missing env var, call secure_env_collect with the missing keys before retrying.",
			"After secure_env_collect completes, re-run the originally blocked command to verify the fix worked.",
			"Never echo, log, or repeat secret values in responses. Only report key names and applied/skipped status.",
		],
		parameters: Type.Object({
			destination: Type.Optional(Type.Union([Type.Literal("dotenv"), Type.Literal("vercel"), Type.Literal("convex")], { description: "Where to write the collected secrets" })),
			keys: Type.Array(
				Type.Object({
					key: Type.String({ description: "Env var name, e.g. OPENAI_API_KEY" }),
					hint: Type.Optional(Type.String({ description: "Format hint shown to user, e.g. starts with sk-" })),
					required: Type.Optional(Type.Boolean()),
					guidance: Type.Optional(Type.Array(Type.String(), { description: "Step-by-step guidance for finding this key" })),
				}),
				{ minItems: 1 },
			),
			envFilePath: Type.Optional(Type.String({ description: "Path to .env file (dotenv only). Defaults to .env in cwd." })),
			environment: Type.Optional(Type.Union([Type.Literal("development"), Type.Literal("preview"), Type.Literal("production")], { description: "Target environment (vercel only)" })),
		}),
		async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (interactive mode required for secure env collection)." }],
					isError: true,
				};
			}

			const destinationAutoDetected = params.destination == null;
			const destination = params.destination ?? detectDestination(ctx.cwd);
			const collected: CollectedSecret[] = [];

			for (let i = 0; i < params.keys.length; i++) {
				const item = params.keys[i];
				const value = await collectOneSecret(ctx, i, params.keys.length, item.key, item.hint, item.guidance);
				collected.push({ key: item.key, value });
			}

			const provided = collected.filter((entry): entry is { key: string; value: string } => entry.value != null);
			const skipped = collected.filter((entry) => entry.value == null).map((entry) => entry.key);
			const { applied, errors } = await applySecrets(provided, destination, {
				envFilePath: resolve(ctx.cwd, params.envFilePath ?? ".env"),
				environment: params.environment,
				exec: (cmd, args) => pi.exec(cmd, args),
			});

			const details: ToolResultDetails = {
				destination,
				environment: params.environment,
				applied,
				skipped,
				...(destinationAutoDetected ? { detectedDestination: destination } : {}),
			};

			const lines = [
				`destination: ${destination}${destinationAutoDetected ? " (auto-detected)" : ""}${params.environment ? ` (${params.environment})` : ""}`,
				...applied.map((key) => `✓ ${key}: applied`),
				...skipped.map((key) => `• ${key}: skipped`),
				...errors.map((error) => `✗ ${error}`),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
				isError: errors.length > 0 && applied.length === 0,
			};
		},
		renderCall(args: any, theme: any) {
			const count = Array.isArray(args.keys) ? args.keys.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("secure_env_collect ")) + theme.fg("muted", `→ ${args.destination ?? "auto"}`) + theme.fg("dim", `  ${count} key${count !== 1 ? "s" : ""}`),
				0,
				0,
			);
		},
		renderResult(result: any, _options: any, theme: any) {
			const details = result.details as ToolResultDetails | undefined;
			if (!details) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const lines = [
				`${theme.fg("success", "✓")} ${details.destination}${details.environment ? ` (${details.environment})` : ""}`,
				...details.applied.map((key) => `  ${theme.fg("success", "✓")} ${key}: applied`),
				...details.skipped.map((key) => `  ${theme.fg("warning", "•")} ${key}: skipped`),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
