// core.ts — lógica pura de emacs-integration, sin dependencias de pi ni TUI.
// Extraída para poder testear con node:test.

import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface FileLink {
	path: string; // absoluto (o URL si url=true)
	line?: number;
	col?: number;
	op?: "created" | "edited";
	url?: boolean;
}

export interface LinkConfig {
	maxLinks: number;
	/** Extensiones aceptadas (sin punto, lowercase). Vacío = cualquiera con extensión. */
	extensions: string[];
	/** Prefijos extra a ignorar (además de los built-in). */
	extraNoise: string[];
}

export const DEFAULT_CONFIG: LinkConfig = {
	maxLinks: 8,
	extensions: [],
	extraNoise: [],
};

/** Rutas que no aportan nada como chip: logs de sesión, caches, temporales. */
export function isNoise(p: string, extra: string[] = []): boolean {
	return (
		p.includes("/.pi/agent/sessions/") ||
		p.startsWith(join(homedir(), ".cache")) ||
		p.startsWith(tmpdir()) ||
		p.includes("/node_modules/") ||
		extra.some((prefix) => p.startsWith(prefix))
	);
}

/** Nombre de archivo válido para chipear: con extensión, sin ocultos. */
export function looksLikeFile(base: string): boolean {
	return /^[\w][\w.-]*\.[A-Za-z0-9]+$/.test(base);
}

/** Rutas de archivo existentes en un texto (tokens, ~, cwd-relativas). */
export function extractFilePaths(text: string, cwd: string, cfg: LinkConfig = DEFAULT_CONFIG): string[] {
	const tokens = text.match(/[^\s`'"|<>{}[\]()]+/g) ?? [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of tokens) {
		// "a.ts:42:7" → "a.ts" (la línea se recupera con lineFor del texto completo)
		let candidate = raw.replace(/[,.;:!?]+$/, "").replace(/:(\d+)(?::(\d+))?$/, "");
		if (!candidate || candidate.length > 4096) continue;
		if (candidate.startsWith("~")) candidate = join(homedir(), candidate.slice(1));
		const base = basename(candidate);
		if (!looksLikeFile(base)) continue;
		if (cfg.extensions.length > 0 && !cfg.extensions.includes(base.split(".").pop()!.toLowerCase())) continue;
		const absolute = resolve(cwd, candidate);
		if (seen.has(absolute)) continue;
		try {
			if (statSync(absolute).isFile()) {
				seen.add(absolute);
				out.push(absolute);
			}
		} catch {
			/* no existe — ignorar */
		}
		if (out.length >= cfg.maxLinks) break;
	}
	return out;
}

/** Extrae línea/columna de un texto para una ruta: "file.ts:42:7" o "file.ts:42".
 *  Prueba la ruta completa y, si no, el basename con límite de palabra. */
export function lineFor(pathname: string, text: string): { line?: number; col?: number } {
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const full = new RegExp(`${esc(pathname)}:(\\d+)(?::(\\d+))?`).exec(text);
	if (full) return { line: Number(full[1]), col: full[2] ? Number(full[2]) : undefined };
	const base = new RegExp(`(?:^|[^\\w])${esc(basename(pathname))}:(\\d+)(?::(\\d+))?`).exec(text);
	if (base) return { line: Number(base[1]), col: base[2] ? Number(base[2]) : undefined };
	// formato compilador: "file.ts(42,7): error" o "file.ts(42)"
	const paren = new RegExp(`(?:^|[^\\w])${esc(basename(pathname))}\\((\\d+)[,:]?(\\d+)?\\)`).exec(text);
	return paren ? { line: Number(paren[1]), col: paren[2] ? Number(paren[2]) : undefined } : {};
}

/** Ruta para mostrar: relativa a cwd si está dentro; si no, últimos 2 segmentos. */
export function displayPath(pathname: string, cwd: string): string {
	if (cwd && pathname.startsWith(`${cwd}/`)) return pathname.slice(cwd.length + 1);
	const segs = pathname.split("/").filter(Boolean);
	if (segs.length <= 2) return pathname;
	return segs.slice(-2).join("/");
}

/** URLs http(s) en un texto, sin puntuación colgante. */
export function extractUrls(text: string, max = 4): string[] {
	const raw = text.match(/https?:\/\/[^\s`'"|<>{}[\]()]+/g) ?? [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const u of raw) {
		const url = u.replace(/[,.;:!?)]+$/, "");
		if (seen.has(url)) continue;
		seen.add(url);
		out.push(url);
		if (out.length >= max) break;
	}
	return out;
}

/** URL corta para chip: host + path truncado. */
export function displayUrl(url: string, maxLen = 60): string {
	try {
		const u = new URL(url);
		const s = `${u.host}${u.pathname}`;
		return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
	} catch {
		return url.slice(0, maxLen);
	}
}

/** Fuzzy: substring en cualquier sitio, o subsecuencia sobre el basename. */
export function fuzzyMatch(query: string, pathname: string): boolean {
	const q = query.toLowerCase();
	if (pathname.toLowerCase().includes(q)) return true;
	const base = basename(pathname).toLowerCase();
	let bi = 0;
	for (const ch of q) {
		bi = base.indexOf(ch, bi);
		if (bi === -1) return false;
		bi += 1;
	}
	return true;
}

/** Extensiones que abrimos en Emacs; el resto (pdf, png, mp4...) con xdg-open. */
export const TEXT_EXTS = new Set([
	"ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx",
	"txt", "py", "rs", "go", "c", "h", "cpp", "hpp", "cc", "java", "rb", "kt", "swift",
	"sh", "bash", "fish", "zsh", "el", "elisp", "lisp", "clj", "ex", "exs", "erl", "lua",
	"toml", "yaml", "yml", "ini", "cfg", "conf", "env", "css", "scss", "less", "html", "htm",
	"xml", "sql", "graphql", "gql", "nix", "dhall", "zig", "nim", "v", "dart", "pl", "r",
	"dockerfile", "makefile", "mk", "cmake", "gradle", "properties", "csv", "tsv", "log",
	"patch", "diff", "gitignore", "gitattributes", "editorconfig", "lock",
]);

/** ¿Abrir en Emacs (texto/código) o con xdg-open (binario/otro)? */
export function shouldOpenInEmacs(pathname: string): boolean {
	const parts = basename(pathname).toLowerCase().split(".");
	// sin extensión → texto (scripts, Makefile, Dockerfile)
	if (parts.length === 1) return true;
	return TEXT_EXTS.has(parts[parts.length - 1]!);
}

/** Argumentos emacsclient para abrir archivo en línea/columna. */
export function clientArgs(file: string, line?: number, col?: number): string[] {
	const pos = line ? (col ? `+${line}:${col}` : `+${line}`) : undefined;
	return pos ? ["-n", "-c", pos, file] : ["-n", "-c", file];
}
