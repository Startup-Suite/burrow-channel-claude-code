// TEMPORARY RENAME GUARD (Burrow rename F, task 01a14ccb). Delete this file
// once Burrow release task E (01a14ba0) finishes: E retires the remaining
// org-name and copyright literals, after which this guard has nothing left
// to protect and is drift (core, suite-cli and every channel plugin carry
// their own copy).
//
// The product is called Burrow. This test fails if any tracked text in the
// repository still names the product by its old name, or misspells the new
// one as a hybrid. Per line, in this order:
//   1. strip every GitHub org literal (the org is still spelled with a
//      hyphen until E) and the lowercase container registry path;
//   2. remove the substrings allowlisted for that path;
//   3. fail on the old bare product word (case-sensitive, whole word), the
//      old two-word product name (any case), or either hybrid spelling.
// Every pattern literal below spells its capital S as a \u0053 escape so that this
// file does not match itself.
//
// Controls: the walk must scan at least MIN_FILES files (an empty or broken
// walk cannot pass), an allowlist entry that matches no line fails as stale,
// and the line checker must flag synthetic offenders.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
// 41 files measured at the commit that added this guard; small margin.
const MIN_FILES = 35;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const SKIP_FILES = new Set(["bun.lock"]);

const STRIP = [/\u0053tartup-\u0053uite/g, /ghcr\.io\/startup-suite/g];
const FORBIDDEN: Array<[string, RegExp]> = [
  ["bare old product word", /\b\u0053uite\b/],
  ["old two-word product name", /startup\s+suite/i],
  ["hybrid (old prefix)", /\u0053tartup Burrow/],
  ["hybrid (old suffix)", /Burrow \u0053uite/],
];

type Entry = { path: string; substring: string; reason: string };
const VERBATIM = "verbatim capture of a core push (test/fixtures/index.ts); must stay byte-identical";
export const ALLOWLIST: Entry[] = [
  {
    path: "test/fixtures/system_event.architecture_review_plan.json",
    substring: "\"author\": \"\u0053tartup \u0053uite\"",
    reason: VERBATIM,
  },
  {
    path: "test/fixtures/system_event.architecture_review_plan.json",
    substring: "Architect on the \u0053uite plan-review path",
    reason: VERBATIM,
  },
  {
    path: "test/system-event-envelope.test.ts",
    substring: "Architect on the \u0053uite plan-review path",
    reason: "quotes the verbatim fixture's bytes inside a recorded failure diff",
  },
];

export function checkLine(text: string, allowed: string[] = []): string[] {
  let line = text;
  for (const re of STRIP) line = line.replace(re, "");
  for (const sub of allowed) line = line.split(sub).join("");
  return FORBIDDEN.filter(([, re]) => re.test(line)).map(([label]) => label);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(path);
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) return [];
    return [path];
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function scan(root: string, allowlist: Entry[]) {
  const used = new Set<Entry>();
  const violations: string[] = [];
  let files = 0;
  for (const abs of walk(root)) {
    let text: string;
    try {
      text = utf8.decode(readFileSync(abs));
    } catch {
      continue; // not UTF-8 text
    }
    files += 1;
    const rel = relative(root, abs).split(sep).join("/");
    const entries = allowlist.filter((e) => e.path === rel);
    text.split("\n").forEach((raw, i) => {
      const hits = entries.filter((e) => raw.includes(e.substring));
      hits.forEach((e) => used.add(e));
      const labels = checkLine(raw, hits.map((e) => e.substring));
      if (labels.length) violations.push(`${rel}:${i + 1}: [${labels.join(", ")}] ${raw.trim()}`);
    });
  }
  const stale = allowlist
    .filter((e) => !used.has(e))
    .map((e) => `stale allowlist entry: ${e.path}: ${JSON.stringify(e.substring)} (${e.reason})`);
  return { files, violations, stale };
}

describe("product name (temporary rename guard, delete after task E)", () => {
  test("no tracked text names the product by its old name", () => {
    const { files, violations, stale } = scan(ROOT, ALLOWLIST);
    expect(files).toBeGreaterThanOrEqual(MIN_FILES);
    expect([...violations, ...stale]).toEqual([]);
  });

  test("control: the line checker flags offenders and passes the org literal", () => {
    expect(checkLine("Welcome to \u0053uite.")).toEqual(["bare old product word"]);
    expect(checkLine("Open \u0053tartup Burrow")).toEqual(["hybrid (old prefix)"]);
    expect(checkLine("a Burrow \u0053uite app")).toContain("hybrid (old suffix)");
    expect(checkLine("STARTUP \u0053UITE")).toEqual(["old two-word product name"]);
    expect(checkLine("see github.com/\u0053tartup-\u0053uite/core")).toEqual([]);
    expect(checkLine("ghcr.io/startup-suite/core:latest")).toEqual([]);
    expect(checkLine("the test suite and SuiteClient")).toEqual([]);
  });
});
