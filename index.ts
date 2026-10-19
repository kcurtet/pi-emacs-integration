// emacs-integration — puente pi ↔ emacsclient (daemon gestionado por emacs.service).
//
// /emacs [ruta]     : abre archivo o carpeta (dired) en frame nuevo, emacsclient -n -c.
//                     Sin argumento: raíz del proyecto.
// /changes          : buffer *pi-changes* con los archivos tocados esta sesión:
//                     botones [a] abrir archivo, [d] diff (si hay git), diff completo abajo.
// /emacs-eval EXPR  : evalúa elisp en el daemon (p.ej. /emacs-eval (org-agenda-list))
// Atajo alt+e       : /emacs sobre el cwd.
// Chips ⏏/+✎        : archivos mencionados en tool results, click abre en Emacs.
//                     Config: PI_EMACS_MAX_LINKS, PI_EMACS_EXTS (csv), PI_EMACS_NOISE (csv rutas).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, HStack, Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	clientArgs,
	displayPath,
	extractFilePaths,
	fuzzyMatch,
	isNoise,
	lineFor,
	shouldOpenInEmacs,
	type FileLink,
	type LinkConfig,
} from "./core.ts";

const CLIENT = process.env.PI_EMACS_CLIENT ?? "emacsclient";
const BUFFER = "*pi-changes*";
const STATE_ENTRY = "emacs-integration:files";
const LINK_ENTRY = "emacs-integration:link";

function linkConfig(): LinkConfig {
	const csv = (v: string | undefined) =>
		v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
	return {
		maxLinks: Number(process.env.PI_EMACS_MAX_LINKS ?? 8) || 8,
		extensions: csv(process.env.PI_EMACS_EXTS),
		extraNoise: csv(process.env.PI_EMACS_NOISE),
	};
}

interface FileRec {
	path: string; // cwd-relativo POSIX
	op: "created" | "edited";
	ops: number;
}

// ---- helpers ----

function notify(ctx: ExtensionContext, msg: string, level: "info" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(msg, level);
	else console.error(`emacs-integration: ${msg}`);
}

function elispStr(s: string): string {
	return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/** Display explícito: un daemon headless (systemd) no tiene TERM; make-frame sin display falla. */
function frameDisplay(): string {
	return process.env.WAYLAND_DISPLAY ?? process.env.DISPLAY ?? ":0";
}

function button(labelText: string, action: string): string {
	return `(insert-button ${elispStr(` ${labelText} `)} 'follow-link t 'action (lambda (&rest _) ${action}))`;
}

/** Evalúa elisp en el daemon sin bloquear. false = client falla o exit != 0. */
function evalInEmacs(script: string): Promise<boolean> {
	return new Promise((res) => {
		const child = spawn(CLIENT, ["-n", "--eval", script], { stdio: "ignore" });
		child.on("error", () => res(false));
		child.on("close", (code: number | null) => res(code === 0));
	});
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((res) => {
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("error", () => res(""));
		child.on("close", (code: number | null) => res(code === 0 ? out : ""));
	});
}

function normalize(raw: string, cwd: string): string {
	const abs = raw.startsWith("/") ? raw : `${cwd}/${raw}`;
	return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1).replaceAll("\\", "/") : abs;
}

function record(files: FileRec[], tool: string, args: { path?: string }, cwd: string): void {
	if (!args.path || (tool !== "edit" && tool !== "write")) return;
	const p = normalize(args.path, cwd);
	const rec = files.find((f) => f.path === p);
	if (rec) {
		rec.op = "edited";
		rec.ops += 1;
	} else {
		files.push({ path: p, op: tool === "write" && !existsSync(resolve(cwd, p)) ? "created" : "edited", ops: 1 });
	}
}

/** Reconstruye estado desde el branch de sesión (ediciones de turnos previos). */
function reconstruct(entries: unknown[], cwd: string): FileRec[] {
	const files: FileRec[] = [];
	for (const e of entries as { type?: string; message?: { content?: { type: string; name?: string; arguments?: { path?: string } }[] } }[]) {
		if (e?.type !== "message" || !e.message?.content) continue;
		for (const c of e.message.content) {
			if (c?.type === "toolCall" && (c.name === "edit" || c.name === "write")) {
				record(files, c.name, { path: c.arguments?.path }, cwd);
			}
		}
	}
	return files;
}

/** Propiedades de texto por entrada: pi-abs, pi-line, pi-diff, pi-full. */
function changesBufferElisp(title: string, files: FileRec[], diffs: Map<string, string>, fullDiff: string | null): string {
	const parts: string[] = [];
	parts.push(
		"(progn",
		`  (let ((buf (get-buffer-create ${elispStr(BUFFER)}))`,
		`        (f (or (car (filtered-frame-list (lambda (fr) (equal (frame-parameter fr 'name) ${elispStr("pi-changes")}))))`,
		`              (make-frame '((name . "pi-changes") (display . ${elispStr(frameDisplay())}))))`,
		`        map next-entry act)`,
		"    (setq next-entry (lambda (dir)",
		"      (let ((pos (point)))",
		"        (while (and (setq pos (if (> dir 0) (next-single-property-change pos 'pi-abs) (previous-single-property-change pos 'pi-abs)))",
		"                    (not (get-char-property pos 'pi-abs))))",
		"          nil)",
		"        (when pos (goto-char pos))))",
		"    (setq act (lambda (key fn) (define-key map key fn)))",
		"    (with-current-buffer buf",
		"      (let ((inhibit-read-only t))",
		"        (erase-buffer)",
		"        (special-mode)",
		"        (setq map (copy-keymap special-mode-map))",
		"        (use-local-map map)",
		`        (funcall act (kbd "TAB") 'forward-button)`,
		`        (funcall act (kbd "<backtab>") 'backward-button)`,
		`        (funcall act (kbd "RET") 'push-button)`,
		`        (funcall act (kbd "<mouse-2>") 'push-button)`,
		`        (funcall act "n" (lambda () (interactive) (funcall next-entry 1)))`,
		`        (funcall act "p" (lambda () (interactive) (funcall next-entry -1)))`,
		`        (funcall act "j" (lambda () (interactive) (funcall next-entry 1)))`,
		`        (funcall act "k" (lambda () (interactive) (funcall next-entry -1)))`,
		`        (funcall act "o" (lambda () (interactive) (push-button (button-at (point)))))`,
		`        (funcall act "q" (lambda () (interactive) (delete-frame f)))`,
		`        (funcall act "d" (lambda () (interactive)`,
		`          (let ((p (get-char-property (point) 'pi-diff))) (when p (find-file-other-window p)))))`,
		`        (setq header-line-format "n/p entrada · RET/o abrir · d diff · TAB botones · q salir")`,
		`        (insert ${elispStr(title)}) (insert "\n\n")`,
	);
	for (const f of files) {
		const abs = resolve(cwdGlobal, f.path);
		const diff = diffs.get(f.path);
		const line = diff ? firstChangedLine(diff) : null;
		const openAction = line ? `(progn (find-file ${elispStr(abs)}) (goto-line ${line}))` : `(find-file ${elispStr(abs)})`;
		parts.push(
			`        (insert ${elispStr(`▸ ${f.path}   ${f.op} · ${f.ops} op${f.ops > 1 ? "s" : ""}`)})`,
			`        (put-text-property (line-beginning-position) (line-end-position) 'pi-abs ${elispStr(abs)})`,
			line ? `        (put-text-property (line-beginning-position) (line-end-position) 'pi-line ${line})` : "",
			diff ? `        (put-text-property (line-beginning-position) (line-end-position) 'pi-diff ${elispStr(writeArtifactSync(diff, f.path))})` : "",
			`        (insert "\\n    ")`,
			`        ${button(line ? `[a] abrir:${line}` : "[a] abrir", openAction)}`,
			diff ? `        (insert "  ")` : "",
			diff ? `        ${button("[d] diff", `(find-file-other-window ${elispStr(writeArtifactSync(diff, f.path))})`)}` : "",
			`        (insert "\\n\\n")`,
		);
	}
	if (fullDiff) {
		parts.push(
			`        (insert "\\n")`,
		`        ${button("[diff completo]", `(find-file-other-window ${elispStr(writeArtifactSync(fullDiff, "full"))})`)}`,
		`        (insert "\\n")`,
		);
	}
	parts.push("        (goto-char (point-min))", "        (hl-line-mode 1)", "        (funcall next-entry 1)", "      )", "    )", "    (with-selected-frame f (switch-to-buffer buf))))");
	return parts.filter((p) => p !== "").join("\n");
}

let cwdGlobal = process.cwd();
let artifactDir = join(tmpdir(), "pi-emacs-integration");

/** Escribe diff como artefacto y devuelve ruta (síncrono: Emacs lo lee justo después). */
function writeArtifactSync(content: string, name: string): string {
	const safe = name.replaceAll(/[^\w.-]/g, "_");
	const p = join(artifactDir, `${Date.now()}-${safe}.diff`);
	try {
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(p, content, "utf8");
	} catch {
		/* best-effort */
	}
	return p;
}

function firstChangedLine(diff: string): number | null {
	const m = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(diff);
	return m ? Number(m[1]) : null;
}

// ---- links clicables en el chat ----

function opFor(toolName: string | undefined): FileLink["op"] {
	return toolName === "write" ? "created" : toolName === "edit" ? "edited" : undefined;
}

/** Línea del texto editado: busca newText del primer edit en el archivo post-edición. */
function editedLine(pathname: string, input: unknown): number | null {
	const inp = input as { edits?: { newText?: string }[]; content?: string } | undefined;
	const needle = inp?.edits?.[0]?.newText ?? inp?.content;
	if (!needle) return null;
	try {
		const content = readFileSync(pathname, "utf8");
		const idx = content.indexOf(needle);
		if (idx === -1) return null;
		return content.slice(0, idx).split("\n").length;
	} catch {
		return null;
	}
}

function openInEmacs(file: string, line?: number, col?: number): Promise<boolean> {
const args = clientArgs(file, line, col);
return new Promise((res) => {
const child = spawn(CLIENT, args, { stdio: "ignore" });
child.on("error", () => res(false));
child.on("close", (code: number | null) => res(code === 0));
});
}

class LinksBar extends Container {
	// HStack compone varios chips en la misma fila y Container.handleMouse
	// despacha solo por fila: sin spans por x, el primer chip se traga todos los clicks.
	// Con >2 archivos se apila un chip por línea (dispatch por fila nativo).
	private readonly rows: { start: number; end: number; file: FileLink }[][] = [];

	constructor(
		files: FileLink[],
		theme: Theme,
		private readonly onFail: (msg: string) => void,
	) {
		super();
		if (files.length === 0) return;
		const GAP = 1;
		const stack = files.length > 2;
		// una "fila lógica" por chip si apilado; todos juntos si inline
		const groups: FileLink[][] = stack ? files.map((f) => [f]) : [files];
		for (const group of groups) {
			const chips: Component[] = [];
			const spans: { start: number; end: number; file: FileLink }[] = [];
			let x = 0;
			for (const f of group) {
				const shown = displayPath(f.path, cwdGlobal);
				const text = f.line ? `${shown}:${f.line}` : shown;
				const plain = `[open - ${text}]`;
				spans.push({ start: x, end: x + plain.length, file: f });
				chips.push(
					new Text(
						theme.fg("muted", "[open - ") +
							theme.style(text, {
								fg: { kind: "rgb", r: 110, g: 168, b: 254 },
								underline: true,
							}) +
							theme.fg("muted", "]"),
						0,
						0,
					),
				);
				x += plain.length + GAP;
			}
			this.rows.push(spans);
			this.addChild(new HStack(chips, { gap: GAP }));
		}
	}

	handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const spans = this.rows[Math.min(event.y, this.rows.length - 1)];
		if (!spans) return undefined;
		const span = spans.find((s) => event.x >= s.start && event.x < s.end);
		if (!span) return undefined;
		const f = span.file;
		if (shouldOpenInEmacs(f.path)) {
			void openInEmacs(f.path, f.line, f.col).then((ok) => {
				if (!ok) this.onFail("emacsclient falló — ¿daemon de Emacs caído?");
			});
		} else {
			const child = spawn("xdg-open", [f.path], { detached: true, stdio: "ignore" });
			child.on("error", () => this.onFail("xdg-open falló al abrir"));
			child.unref();
		}
		return { handled: true } as ReturnType<Container["handleMouse"]>;
	}
}

export default function emacsIntegration(pi: ExtensionAPI) {
	let files: FileRec[] = [];
	let sessionId = "unknown";
	// último tool que chipeó cada archivo (dedupe suave consecutivo)
	const lastChip = new Map<string, string | undefined>();

	// ---- lifecycle ----

	pi.on("session_start", async (_e, ctx) => {
		cwdGlobal = ctx.sessionManager.getCwd();
		sessionId = ctx.sessionManager.getSessionId();
		artifactDir = join(homedir(), ".cache", "pi", "emacs-integration", sessionId.replace(/[^\w-]/g, "_"));
		// SAFETY: SessionEntry[] de pi es estructuralmente compatible con las
		// entradas duck-typed que consume reconstruct; campos extra se ignoran y
		// las formas desconocidas se saltan de forma defensiva dentro de reconstruct.
		const branch = ctx.sessionManager.getBranch() as unknown as Parameters<typeof reconstruct>[0];
		// último estado persistido, o reconstrucción desde historial
		let persisted: FileRec[] | undefined;
		for (const e of branch as { type?: string; customType?: string; data?: string }[]) {
			if (e?.type === "custom" && e.customType === STATE_ENTRY) {
				try {
					persisted = JSON.parse(e.data!);
				} catch {
					/* ignora basura */
				}
			}
		}
		files = persisted ?? reconstruct(branch, cwdGlobal);
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const input = event.input as { path?: string };
		if (input?.path) record(files, event.toolName, input, cwdGlobal);
	});

	pi.on("agent_settled", async () => {
		pi.appendEntry(STATE_ENTRY, JSON.stringify(files));
	});

	// ---- comandos ----

	/** Fuzzy sobre archivos tocados/mencionados en la sesión. */
	function fuzzyCandidates(q: string): string[] {
		const cands = new Set<string>();
		for (const f of files) cands.add(resolve(cwdGlobal, f.path));
		for (const p of lastChip.keys()) cands.add(p);
		return [...cands].filter((p) => fuzzyMatch(q, p));
	}

	async function openPath(ctx: ExtensionContext, arg?: string): Promise<void> {
		const target = resolve(cwdGlobal, arg ?? ".");
		if (arg && !existsSync(target)) {
			notify(ctx, `No existe: ${target}`, "error");
			return;
		}
		// Con build PGTK (emacs-wayland) emacsclient -n -c funciona sin tty.
		const ok = await new Promise<boolean>((res) => {
			const child = spawn(CLIENT, ["-n", "-c", target], { stdio: "ignore" });
			child.on("error", () => res(false));
			child.on("close", (code: number | null) => res(code === 0));
		});
		if (!ok) notify(ctx, "emacsclient falló — ¿daemon de Emacs caído?", "error");
	}

	async function showChanges(ctx: ExtensionContext): Promise<void> {
		if (files.length === 0) {
			notify(ctx, "El agente no ha tocado archivos todavía");
			return;
		}
		// diffs por archivo (solo si hay git)
		const diffs = new Map<string, string>();
		let fullDiff: string | null = null;
		const isRepo = (await run("git", ["rev-parse", "--is-inside-work-tree"], cwdGlobal)).trim() === "true";
		if (isRepo) {
			for (const f of files) {
				const d = await run("git", ["diff", "HEAD", "--", f.path], cwdGlobal);
				if (d.trim()) {
					diffs.set(f.path, d);
				} else {
					const st = await run("git", ["status", "--porcelain", "--", f.path], cwdGlobal);
					if (st.includes("??")) diffs.set(f.path, ""); // nuevo sin tracking: sin diff
				}
			}
			const paths = files.map((f) => f.path.replaceAll("'", "'\\''"));
			const raw = await run("bash", ["-c", `git diff HEAD -- ${paths.map((p) => `'${p}'`).join(" ")}`], cwdGlobal);
			fullDiff = raw.trim() || null;
		}
		const title = `pi-changes · sesión · ${files.length} archivo${files.length > 1 ? "s" : ""}${isRepo ? "" : " · sin git (solo listado)"}`;
		const script = changesBufferElisp(title, files, diffs, fullDiff);
		// lexical-binding solo se respeta leyendo desde archivo con header — eval
		// directo por emacsclient usa scope dinámico y los lambdas revientan.
		const scriptFile = join(artifactDir, "changes-script.el");
		try {
			mkdirSync(artifactDir, { recursive: true });
			writeFileSync(scriptFile, `;;; -*- lexical-binding: t; -*-\n${script}\n`, "utf8");
		} catch (err) {
			notify(ctx, `No pude escribir ${scriptFile}: ${String(err)}`, "error");
			return;
		}
		const ok = await evalInEmacs(`(load ${elispStr(scriptFile)} nil t)`);
		if (!ok) notify(ctx, "emacsclient no disponible — revisa el daemon de Emacs", "error");
	}

	pi.on("tool_result", async (event) => {
		if ((event as { isError?: boolean }).isError) return;
		const texts: string[] = [];
		for (const block of event.content ?? []) {
			if (block.type === "text") texts.push(block.text);
		}
		const input = event.input as { path?: string; file_path?: string } | undefined;
		if (typeof input?.path === "string") texts.push(input.path);
		if (typeof input?.file_path === "string") texts.push(input.file_path);
		const cfg = linkConfig();
		const text = texts.join("\n");
		const paths = extractFilePaths(text, cwdGlobal, cfg).filter((p) => !isNoise(p, cfg.extraNoise));
		// línea de error/aviso si el resultado la menciona: "file.ts:42"
		const toolName = (event as { toolName?: string }).toolName;
		// dedupe suave: mismo archivo por el mismo tool consecutivo → 1 chip
		const files: FileLink[] = paths
			.filter((p) => lastChip.get(p) !== toolName)
			.map((p) => {
				lastChip.set(p, toolName);
				const mentioned = lineFor(p, text);
				if (mentioned.line) return { path: p, ...mentioned, op: opFor(toolName) };
				// read con offset: saltar ahí
				if (toolName === "read") {
					const off = (event.input as { offset?: number } | undefined)?.offset;
					if (off && off > 0) return { path: p, line: off, op: undefined };
				}
				// edit/write: línea del texto insertado, buscándolo en el archivo
				const line = editedLine(p, event.input);
				return { path: p, line: line ?? undefined, op: opFor(toolName) };
			});
		if (files.length > 0) pi.appendEntry(LINK_ENTRY, { files });
	});

	pi.registerEntryRenderer(LINK_ENTRY, (entry, _options, theme) => {
		const files = (entry.data as { files?: FileLink[] } | undefined)?.files ?? [];
		if (files.length === 0) return undefined;
		return new LinksBar(files, theme, (msg) => {
			console.error(`emacs-integration: ${msg}`);
		});
	});

	pi.registerCommand("emacs", {
		description: "Open file or folder in Emacs; fuzzy-matches session files if path doesn't exist",
		getArgumentCompletions: (prefix) => {
			const hits = fuzzyCandidates(prefix || "");
			return hits.slice(0, 20).map((p) => ({
				value: p,
				label: displayPath(p, cwdGlobal),
				description: "sesión",
			}));
		},
		handler: async (args, ctx) => {
			const arg = args?.trim() || undefined;
			if (arg && !existsSync(resolve(cwdGlobal, arg))) {
				const hits = fuzzyCandidates(arg);
			if (hits.length === 0) {
				notify(ctx, `No existe: ${arg} (ni match fuzzy en archivos de la sesión)`, "error");
				return;
			}
			const pick =
				hits.length === 1
					? hits[0]
					: await ctx.ui.select("Abrir en Emacs", hits.map((h) => displayPath(h, cwdGlobal)));
				if (pick === undefined) return;
				const chosen = hits.length === 1 ? hits[0] : hits[hits.map((h) => displayPath(h, cwdGlobal)).indexOf(pick)];
				await openPath(ctx, chosen);
				return;
			}
			await openPath(ctx, arg);
		},
	});

	pi.registerCommand("changes", {
		description: "Show session-changed files in an Emacs buffer (*pi-changes*)",
		handler: async (_args, ctx) => showChanges(ctx),
	});

	pi.registerCommand("emacs-eval", {
		description: "Evaluate elisp in the Emacs daemon",
		handler: async (args, ctx) => {
			const expr = args?.trim();
			if (!expr) {
				notify(ctx, "Uso: /emacs-eval EXPR", "error");
				return;
			}
			const ok = await evalInEmacs(expr);
			if (!ok) notify(ctx, "emacsclient falló al evaluar", "error");
		},
	});

	pi.registerShortcut("alt+e", {
		description: "Open project root in Emacs",
		handler: async (ctx) => openPath(ctx),
	});
}
