import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractFilePaths, isNoise, lineFor, displayPath, clientArgs, looksLikeFile } from "./core.ts";

function tmpProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "core-test-"));
	writeFileSync(join(dir, "a.txt"), "x");
	writeFileSync(join(dir, "emacs-integration.ts"), "x");
	writeFileSync(join(dir, ".hidden"), "x");
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "b.md"), "x");
	return dir;
}

test("extract: básico + relativas + dedupe", () => {
	const dir = tmpProject();
	const out = extractFilePaths(`edita a.txt y sub/b.md, luego a.txt otra vez`, dir);
	assert.deepEqual(out, [join(dir, "a.txt"), join(dir, "sub", "b.md")]);
});

test("extract: nombres con guiones", () => {
	const dir = tmpProject();
	const out = extractFilePaths("fallo en emacs-integration.ts", dir);
	assert.deepEqual(out, [join(dir, "emacs-integration.ts")]);
});

test("extract: no archivos ocultos ni inexistentes", () => {
	const dir = tmpProject();
	assert.deepEqual(extractFilePaths(".hidden nope.ts", dir), []);
});

test("extract: maxLinks", () => {
	const dir = tmpProject();
	const out = extractFilePaths("a.txt a.txt", dir, { maxLinks: 8, extensions: [], extraNoise: [] });
	assert.equal(out.length, 1);
});

test("extract: filtro por extensión", () => {
	const dir = tmpProject();
	const out = extractFilePaths("a.txt sub/b.md", dir, { maxLinks: 8, extensions: ["md"], extraNoise: [] });
	assert.deepEqual(out, [join(dir, "sub", "b.md")]);
});

test("isNoise: sessions, cache, tmp, node_modules", () => {
	assert.ok(isNoise("/home/x/.pi/agent/sessions/foo.jsonl"));
	assert.ok(isNoise(`${homedir()}/.cache/pi/foo`));
	assert.ok(isNoise("/tmp/foo.txt"));
	assert.ok(isNoise("/repo/node_modules/x/y.js"));
	assert.ok(!isNoise("/repo/src/a.ts"));
	assert.ok(isNoise("/opt/x.bin", ["/opt"]));
});

test("lineFor: línea y columna", () => {
	const t = "error en a.txt:42:7 y b.md:3";
	assert.deepEqual(lineFor("/p/a.txt", t), { line: 42, col: 7 });
	assert.deepEqual(lineFor("/p/b.md", t), { line: 3, col: undefined });
	assert.deepEqual(lineFor("/p/c.txt", t), {});
});

test("displayPath: relativa, ~, absoluta", () => {
	assert.equal(displayPath("/repo/src/a.ts", "/repo"), "src/a.ts");
	assert.equal(displayPath(`${process.env.HOME}/dev/x.ts`, "/otro"), "~/dev/x.ts");
	assert.equal(displayPath("/opt/x.ts", "/repo"), "/opt/x.ts");
});

test("clientArgs: con/sin posición", () => {
	assert.deepEqual(clientArgs("/f.ts"), ["-n", "-c", "/f.ts"]);
	assert.deepEqual(clientArgs("/f.ts", 10), ["-n", "-c", "+10", "/f.ts"]);
	assert.deepEqual(clientArgs("/f.ts", 10, 3), ["-n", "-c", "+10:3", "/f.ts"]);
});

test("looksLikeFile: casos límite", () => {
	assert.ok(looksLikeFile("a.ts"));
	assert.ok(looksLikeFile("a-b.c.ts"));
	assert.ok(!looksLikeFile("sinext"));
	assert.ok(!looksLikeFile("palabra."));
});
