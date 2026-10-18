// Guard: this plugin names no dotted Burrow server tool (task 01a14a7f stage 2).
//
// Burrow core is renaming its dotted MCP tools (`skill.list`, `canvas.create`,
// `attachment.upload_start`, `prototype.publish`, `feedback.submit`, ...) to
// underscore names. This plugin is unaffected TODAY because it calls no server
// tool by name: its only tools are the local ones it serves to Claude Code
// (src/tools.ts), carried to Burrow as runtime-socket events (reply, typing,
// reply_chunk, reply_with_media, meeting_transcript_ack, pong), never as
// `tool_call` frames. Claude Code reaches core's tools over HTTP /mcp and takes
// their names from the live tools/list.
//
// This test keeps that true. If a later change makes src/ name a dotted server
// tool, it fails here, and that change must add underscore-first handling
// (with a dotted fallback for old servers) instead of hard-coding the dot.
//
// The check walks the TypeScript AST, so it sees every string literal and
// template-literal text segment in src/, not just one quoting style. Two
// controls keep it from passing vacuously: src/ must yield a non-trivial
// number of literals, and the same extractor must catch a planted
// `"skill.list"` in a synthetic source.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SERVER_TOOL = /^(canvas|skill|attachment|prototype|feedback)\.[a-z_]+$/;
const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

type Literal = { file: string; line: number; text: string };

function stringLiterals(file: string, source: string): Literal[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Literal[] = [];
  const record = (node: ts.Node, text: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ file, line: line + 1, text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      record(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function offenders(literals: Literal[]): string[] {
  return literals
    .filter((l) => SERVER_TOOL.test(l.text.trim()))
    .map((l) => `${l.file}:${l.line} ${JSON.stringify(l.text)}`);
}

describe("no dotted server tool names in src/", () => {
  test("src/ contains no string literal naming a dotted server tool", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(0);

    const literals = files.flatMap((f) =>
      stringLiterals(f, readFileSync(f, "utf8")),
    );
    // Non-vacuity: src/ has hundreds of literals. If this drops to a handful,
    // the walker has stopped seeing the code, not the code got clean.
    expect(literals.length).toBeGreaterThan(50);

    expect(offenders(literals)).toEqual([]);
  });

  test("positive control: the same extractor catches a planted name", () => {
    const planted = [
      `const a = "skill.list";`,
      "const b = `canvas.create`;",
      `const c = 'attachment.upload_start';`,
      `const ok = "suite_reply";`,
      `const path = "package.json";`,
    ].join("\n");
    const hits = offenders(stringLiterals("planted.ts", planted));
    expect(hits).toEqual([
      'planted.ts:1 "skill.list"',
      'planted.ts:2 "canvas.create"',
      'planted.ts:3 "attachment.upload_start"',
    ]);
  });
});
