// Source-scan guard that makes this repo's copy of the `system_event` envelope
// decision record NAVIGABLE: it must claim exactly one identity, name both of
// its siblings, carry a falsifier, and cite by anchor rather than by line
// number (task `019fa63a-02a0`, stage 4).
//
// THE MIRROR HALF. Core carries the same audit at
// `core:apps/platform/test/platform/regression/system_event_envelope_record_audit_test.exs`
// (stage 3). That one RESOLVES its two local records against the filesystem —
// path, `§` anchor, and the reciprocal self-header — and it says explicitly, in
// its own assertion 8, that it CANNOT do any of that for record 3, which lives
// here. This file is the other side of that sentence: record 3 is on disk from
// here and its two siblings are not, so the resolution directions are exactly
// inverted. Neither file can do the whole job; together they cover both repos.
//
// THE BUG BEING PINNED. One decision was recorded three times, in three files,
// in two repos, and no copy pointed at the others. A reader who found one had
// no way to learn the other two existed, or that one of them carried a
// retirement condition the others did not. Two of the pointers that DID exist
// were LINE PINS and both had already rotted while still reading as confident
// pointers — `agent_responder.ex:485-487` had drifted into an unrelated comment
// block, and `router.ex:1447` no longer lands on the whitelist it names. This
// file's line-pin assertion is what stops the next one being written.
//
// ── WHAT THIS AUDIT CANNOT DO ──────────────────────────────────────────────
//
// IT CANNOT RESOLVE A SINGLE ONE OF THIS RECORD'S REFERENCES. Both siblings are
// `core:` references and core is not on disk from here. The reference
// assertions below are SHAPE checks — known repo token, source-file-shaped path
// — and green on them means "this is shaped like a reference", nothing more. It
// does not mean record 1 or record 2 exists, is where the reference says, or
// carries the anchor claimed for it. That resolution belongs to core's audit,
// which performs it.
//
// IT CANNOT CHECK THAT THE RECORD IS TRUE. `WHAT WOULD RETIRE THIS:` is checked
// for PRESENCE, not for saying anything worth falsifying. Whether the condition
// stated is the real one is a human judgement.
//
// THE ANCHOR ASSERTION IS WEAKER THAN CORE'S, AND SAYS SO. Core's reciprocity
// assertion passes only when two independently written files agree; the anchor
// literal it checks is read out of the referring record's own source. Here, the
// anchor that core's two records cite for record 3 (`makeEmitAttention`) has to
// be RESTATED as a constant, because the text that names it is in the other
// repo. So that test is closer to "this file still contains the symbol core
// points at" than to a real cross-check. It is kept anyway — a stale cross-repo
// pointer is the exact defect this task exists to remove, and half a check on
// it beats none — but it is not the same instrument as core's assertion 5.
//
// ── CORPUS SELECTION ───────────────────────────────────────────────────────
//
// DISCOVERED, not listed: every `src/**/*.ts` carrying the marker. A hardcoded
// path would silently stop auditing the record the moment someone moved it.
// Exactly one is expected — records 1 and 2 are in core — and that count is
// asserted inside `the scan is not vacuous`, deliberately in the SAME test as
// the emptiness floors, so that renaming the marker fails ONE assertion with
// one clear cause instead of eight with a misleading one.
//
// The marker is assembled from two halves so this file never contains it
// contiguously: the corpus is SELECTED by the marker, and `test/` is outside
// the walk today, but a literal here would make that exclusion load-bearing
// rather than incidental. Same trick core's audit uses, for the same reason.
//
// ── ANTI-VACUITY ───────────────────────────────────────────────────────────
//
// Every assertion outside the last test is a statement about a LIST, so all
// eight pass against an empty corpus. Rename the marker, break the reference
// regex, or point the walk at the wrong root and this file goes green while
// guarding nothing. `the scan is not vacuous` is the only thing standing
// between that and a silent all-pass, and control 6 below measures that it
// actually is.
//
// ONE DELIBERATE DIFFERENCE FROM CORE'S CONTROL. Core floors its reference
// count at the exact number it expects (four: two records naming two siblings).
// This file floors at ONE, not two, because with a single local record an exact
// floor would just restate the arity assertion — and then deleting a reference
// would fail two tests with two different explanations for one defect. The
// floor here answers "did the regex match anything at all"; arity is test 2's
// job alone. Control 1 measures that split.
//
// ── THE MUTATION CONTROLS ──────────────────────────────────────────────────
//
// Every row was APPLIED to this worktree, run with `bun test`, transcribed from
// the run rather than predicted, and REVERTED with `git status` confirming a
// clean tree between rows.
//
// MEASURED BASELINES, whole suite. `origin/main` (`4edd170`): 72 pass, 0 fail,
// 244 expect(), 5 files. This branch at stage 4: 81 pass, 0 fail, 257 expect(),
// 6 files. This branch after the pin-ban widening below: 82 pass, 0 fail, 258
// expect(), 6 files. `tsc --noEmit` exits 0 at all three. Assertions were
// ADDED; none were removed, relaxed or deleted.
//
// WHY THIS FILE MAY CONTAIN THE SHAPE IT BANS. The header and the failure
// messages below quote `agent_responder.ex:485-487` and `router.ex:1447`
// verbatim, which `BARE_LINE_PIN_RE` would reject in a record. This file is not
// a record and is not in its own corpus — the walk is `src/**/*.ts`, and the
// specimens are quoted here AS specimens, the way a test fixture may contain
// the malformed input it tests. Records get the ban; the evidence locker does
// not.
//
// Every mutation below is applied to the RECORD in `src/attention.ts`.
//
// | # | mutation | observed |
// |---|---|---|
// | 1 | delete the `2/3` sibling reference | 80 pass / **1 fail** — `the record names both other records exactly once`: `src/attention.ts — is record 3/3 and names [1], but must name exactly [1,2]`. The non-vacuity control still PASSES, which is exactly why its reference floor is one and not two. |
// | 2 | self-header `3/3` → `1/3` | 78 pass / **3 fail**. Both predicted tests fire, so they are NOT masking each other: `claims to be record 1/3, but this repo holds record 3/3` and `is record 1/3 and names [1,2], but must name exactly [2,3]`. A third fires that the plan did not predict, and it is correct rather than noise — `is record 1/3 and cites itself as a sibling: 1/3 core:…`. A renumbered header genuinely does turn one of its own references into a self-citation. |
// | 3 | add `:532` to the `build_system_event_signal/2` citation | 80 pass / **1 fail** — `no citation carries a line pin`: ``line-pinned citation: //   `core:…/agent_responder.ex:532 §``. It fires ONLY because the pin check scans every CITATION line rather than the two sibling-reference lines alone. Scoped to references, as core's audit is, this mutation goes green — which is why the scope here is wider than core's. |
// | 4 | delete the `WHAT WOULD RETIRE THIS:` line | 80 pass / **1 fail** — `the record carries all four clause labels`: ``src/attention.ts — is missing `WHAT WOULD RETIRE THIS:` ``. |
// | 5 | `core:` → `cores:` on the `1/3` reference | 80 pass / **1 fail** — `every reference names a known repo and a source-shaped path`. THE DISCRIMINATION CHECK, and it holds: the non-vacuity control PASSES, because it asks whether ANY `core:` reference parsed and the `2/3` one still does. **FIRST RUN OF THIS ROW FAILED TWO TESTS, AND THE SECOND FAILURE WAS THIS FILE'S BUG, not the mutation's finding.** `every reference is cross-repo` was written as `repo !== "core"`, so a broken repo token read as "a reference into THIS repo" — it would also have misreported a legitimate `openclaw-suite-channel:` reference. Fixed to test the local repo token by name; the row above is the re-run. Recorded rather than quietly repaired: a control that fires for the wrong reason is a finding about the audit. |
// | 6 | rename the marker (`ENVELOPE-…` → `DECISION-NOTE`) | 80 pass / **1 fail**, and `the scan is not vacuous` is the ONLY failure: `the corpus walk found 0 record file(s) under \`src/\``. Every other assertion ran against an empty corpus and passed — 253 expect() calls instead of 257, because the vacuity test aborts at its first assertion. That is the entire reason the corpus count lives inside this test rather than beside it. |
//
// ── ROWS 7-10: THE PIN BAN WAS BANNING THE WRONG SHAPE ─────────────────────
//
// Row 3 above says the pin check "scans every CITATION line rather than the two
// sibling-reference lines alone", and treats that as the wide scope. IT WAS NOT
// WIDE ENOUGH, and the row said so without noticing: `CITATION_RE` requires a
// `<repo>:` prefix, so the ban only ever applied to prefixed pins. Every pin
// this task actually removed was BARE. A reviewer demonstrated the escape —
// appending `(see agent_responder.ex:485)` inside the record scored a full
// green where it should have failed. Rows 7-10 are the fix, measured the same
// way. Row 7 is the widening observed FAILING before anything was rewritten;
// a widened check never seen red is a widened check nobody can vouch for.
//
// | # | mutation | observed |
// |---|---|---|
// | 7 | none — widen the ban (`BARE_LINE_PIN_RE` + the new test), leave the record's two live pins in place | 81 pass / **1 fail**, the new test alone, naming both survivors: ``src/attention.ts (line 208) — line pin `agent_responder.ex:485-487` `` and ``(line 228) — line pin `router.ex:1447` ``. THE POINT OF THE ROW: the check was watched failing on real pins before they were rewritten. De-pinning both into prose (`… into \`router.ex\` at line 1447`) then returns 82 pass / 0 fail with the forensic sentences fully intact. |
// | 8 | the reviewer's escape — append `(see agent_responder.ex:485)` to a line inside the record block | 81 pass / **1 fail** — `no line pin survives anywhere in the record, prefixed or bare`, naming line 105. This is the mutation that scored 81 pass / **0 fail** before the widening. It now detonates, and the narrower `no citation carries a line pin` stays GREEN, which is correct: there is no citation on that line, only a bare mention. That split is why the two tests are separate. |
// | 9 | row 3 re-run — add `:532` to the `build_system_event_signal/2` citation | 80 pass / **2 fail**, and BOTH pin tests fire: `no citation carries a line pin` (unchanged, so the widening did not break it) and the new one. A prefixed pin is still a pin; it is now caught twice, by two selectors, each naming which one it was. |
// | 10 | THE DISCRIMINATION ROW — inject `12:30`, `2026-07-31T19:32:18.053Z`, `1.4:2`, `v1.2.3`, `localhost:4000`, `16:9`, a bare `index.ts` | 82 pass / **0 fail**. Every one is inert: the ban demands a source extension immediately followed by `:` and a digit, so ordinary prose, times, versions, ports and unpinned filenames do not trip it. **AND ONE RESULT THAT WAS NOT PREDICTED:** `package.json:5` and `process-patterns.md:12` are ALSO inert. Pins into non-source files are not banned by either audit — including into `process-patterns.md`, which is where the org rule being enforced actually lives. Left as-is and documented at `BARE_LINE_PIN_RE` rather than silently widened: `.md:`/`.json:` carry a different false-positive profile and this task's defect was bare SOURCE pins. Reported rather than quietly fixed, and rather than quietly dropped. |

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Glob } from "bun";

const MARKER = "ENVELOPE-" + "RECORD";

const REPO_ROOT = resolve(import.meta.dir, "..");

// The record this repo is expected to hold. Records 1 and 2 are in core.
const LOCAL_RECORD_NUMBER = 3;
const ALL_RECORD_NUMBERS = [1, 2, 3];

// The anchor core's two records cite for record 3. Restated, not read — see the
// caveat in the header.
const CORE_CITED_PATH = "src/attention.ts";
const CORE_CITED_ANCHOR = "export function makeEmitAttention(";

// The marker as a standalone token. The negative lookahead is load-bearing:
// without it `<MARKER>X` still matches on the substring, so renaming the marker
// would leave the file in the corpus carrying zero parseable headers and fail
// the self-header test for a cause that has nothing to do with headers.
const MARKER_RE = new RegExp(`${MARKER}(?![A-Za-z0-9_-])`);

// A record's claim about its own identity. One per record file.
const SELF_HEADER_RE = new RegExp(`${MARKER}\\s+(\\d)\\/3`);

// A reference to a sibling record: number, repo token, path, `§` anchor, and the
// task that established it. The whole construct must be on ONE source line — a
// reference wrapped across two lines is invisible to this audit while still
// looking resolvable to a human reviewer.
const REFERENCE_RE = /(\d)\/3\s+([a-z0-9-]+):(\S+)\s+§\s+(.+?)\s+\((019f[0-9a-f-]+)\)/;

// The head of a reference, used to catch lines that MEANT to be references —
// including malformed ones the full grammar rejects — so a broken reference
// still reaches the arity and pin checks instead of vanishing from them.
const REFERENCE_HEAD_RE = /(\d)\/3\s+[a-z0-9-]+:/;

// ANY cross-repo citation, not just a sibling reference: `<repo>:<path>` naming
// a source file. This record cites core in its prose too — the dual-write sites
// its falsifier turns on — and those citations rot exactly like the sibling
// ones do. Scoping the pin check to sibling references alone would have let
// control 3 through.
//
// The repo token prefix is what distinguishes a CITATION from prose mentioning
// a filename. It is still the right selector for THIS constant — a bare
// filename is not a cross-repo citation — but see `BARE_LINE_PIN_RE` for why it
// is the wrong selector for the pin ban.
const CITATION_RE = /\b[a-z0-9-]+:[\w./-]+\.(?:ex|exs|ts|tsx|js|mjs)/;

// A source path followed by a colon and a digit: the banned position pin.
const LINE_PIN_RE = /\.(ex|exs|ts):\d/;

// THE SAME BAN, WITHOUT THE REPO-TOKEN PREREQUISITE, and applied to EVERY line
// of a record rather than to citation lines alone.
//
// This exists because the original pin check banned only the shape that did not
// rot. `LINE_PIN_RE` is only ever consulted for lines `CITATION_RE` or
// `REFERENCE_HEAD_RE` already selected, and both of those require a `<repo>:`
// prefix. Every pin this task actually found was BARE — `agent_responder.ex`
// and a line range, `router.ex` and a line number, no repo token in sight — so
// the ban as first written was enforced for the one form that had never been a
// problem here, and silent about the form that put a reader 47 lines inside an
// unrelated comment block. A reviewer proved it rather than arguing it:
// appending a bare pin to a line inside the record scored 81 pass / 0 fail,
// while the repo-prefixed equivalent correctly failed. Control rows 7-10 are
// the re-measurement after this constant landed.
//
// Widening the SELECTOR instead — teaching `CITATION_RE` to accept bare
// filenames — was rejected: `citationLines` also feeds nothing else today, but
// the name would then be a lie, and "line mentioning a file" is genuinely not
// "cross-repo citation". Two constants, two questions.
//
// The extension list is what keeps this from firing on ordinary prose. A clock
// time (`12:30`), a timestamp (`…T19:32:18.053Z`), a bare version (`1.4:2`), a
// port (`localhost:4000`), a ratio (`16:9`) and a filename with no position
// (`index.ts`) all fail it, because it demands a source-file extension
// IMMEDIATELY followed by a colon and a digit. Control row 10 measures that
// rather than asserting it.
//
// KNOWN BOUNDARY, measured by the same control and left in place deliberately:
// the list is SOURCE extensions, so a pin into a non-source file —
// `package.json:5`, `process-patterns.md:12` — does not match and is not
// banned. That is a real gap, and a slightly awkward one given the org rule
// this enforces lives in a markdown file that pins would rot the same way.
// Left alone because widening the list is a different decision with a
// different false-positive profile (`.md:` and `.json:` turn up in prose far
// more often than `.ex:` does) and this task's defect was bare SOURCE pins.
// Recorded here so the next reader knows it is a boundary someone measured,
// not one nobody noticed.
//
// The trailing `\d+(?:-\d+)?` is for the REPORT, not the trigger: `:\d` alone
// matches identically, but quotes back `agent_responder.ex:4` for a pin that
// reads `agent_responder.ex:485-487`, and a failure message that misquotes the
// offending text costs the reader the one thing it was there to give them.
const BARE_LINE_PIN_RE = /\b[\w.-]+\.(?:ex|exs|ts|tsx|js|mjs):\d+(?:-\d+)?/;

const SOURCE_PATH_RE = /\.(ex|exs|ts|tsx|js|mjs)$/;

const KNOWN_REPOS = ["core", "claude-code-suite-channel", "openclaw-suite-channel"];

// This repo's own token — the only one a reference could be resolved against
// from here.
const LOCAL_REPO = "claude-code-suite-channel";

const CLAUSE_LABELS = ["DECIDED:", "WHY:", "WHAT WOULD RETIRE THIS:", "RETIREMENT STATUS"];

interface Reference {
  record: string;
  line: number;
  number: number;
  repo: string;
  path: string;
  anchor: string;
  task: string;
  raw: string;
}

interface Record {
  path: string;
  source: string;
  number: number | null;
  selfHeaders: Array<{ number: number; line: number }>;
  references: Reference[];
  citationLines: Array<{ line: number; text: string }>;
  // Every line carrying a pin, citation or not — the wider scan. Not a subset
  // relation in either direction: a repo-prefixed pin appears in both lists, a
  // bare one only here, and a citation with a `§` anchor only in the other.
  pinnedLines: Array<{ line: number; text: string; pin: string }>;
  missingLabels: string[];
  markerLine: number;
}

function buildRecord(path: string, source: string): Record {
  const lines = source.split("\n");

  const selfHeaders: Array<{ number: number; line: number }> = [];
  const references: Reference[] = [];
  const citationLines: Array<{ line: number; text: string }> = [];
  const pinnedLines: Array<{ line: number; text: string; pin: string }> = [];
  let markerLine = 0;

  lines.forEach((text, index) => {
    const lineNumber = index + 1;

    const header = SELF_HEADER_RE.exec(text);
    if (header) selfHeaders.push({ number: Number(header[1]), line: lineNumber });

    if (!markerLine && MARKER_RE.test(text)) markerLine = lineNumber;

    const reference = REFERENCE_RE.exec(text);
    if (reference) {
      references.push({
        record: path,
        line: lineNumber,
        number: Number(reference[1]),
        repo: reference[2]!,
        path: reference[3]!,
        anchor: reference[4]!,
        task: reference[5]!,
        raw: reference[0].trim(),
      });
    }

    if (REFERENCE_HEAD_RE.test(text) || CITATION_RE.test(text)) {
      citationLines.push({ line: lineNumber, text: text.trim() });
    }

    // Unconditional — no selector runs first. That is the whole point: the
    // selector is what the bare pins escaped through.
    const pin = BARE_LINE_PIN_RE.exec(text);
    if (pin) pinnedLines.push({ line: lineNumber, text: text.trim(), pin: pin[0] });
  });

  return {
    path,
    source,
    number: selfHeaders.length === 1 ? selfHeaders[0]!.number : null,
    selfHeaders,
    references,
    citationLines,
    pinnedLines,
    missingLabels: CLAUSE_LABELS.filter((label) => !source.includes(label)),
    markerLine,
  };
}

// The corpus is DISCOVERED. Comments are NOT stripped — every reference lives
// in one, so stripping would leave an empty buffer and pass forever.
function scanRecords(): Record[] {
  const paths = [...new Glob("src/**/*.ts").scanSync(REPO_ROOT)].sort();

  return paths
    .map((path) => ({ path, source: readFileSync(resolve(REPO_ROOT, path), "utf8") }))
    .filter(({ source }) => MARKER_RE.test(source))
    .map(({ path, source }) => buildRecord(path, source));
}

const RECORDS = scanRecords();
const REFERENCES = RECORDS.flatMap((record) => record.references);

function report(offenders: string[], explanation: string): string {
  return `${explanation.trim()}\n\nOffending sites:\n${offenders.map((o) => `  ${o}`).join("\n")}`;
}

describe("the envelope record cross-references its siblings", () => {
  test("the record carries exactly one self-header, and it claims 3/3", () => {
    const offenders = RECORDS.flatMap((record) => {
      if (record.selfHeaders.length !== 1) {
        return [
          `${record.path} — carries ${record.selfHeaders.length} self-headers ` +
            `(${JSON.stringify(record.selfHeaders.map((h) => h.number))}); a record must ` +
            `claim exactly one identity`,
        ];
      }
      if (record.number !== LOCAL_RECORD_NUMBER) {
        return [
          `${record.path} (line ${record.selfHeaders[0]!.line}) — claims to be record ` +
            `${record.number}/3, but this repo holds record ${LOCAL_RECORD_NUMBER}/3; ` +
            `records 1 and 2 are in core`,
        ];
      }
      return [];
    });

    expect(
      offenders,
      report(
        offenders,
        `A record's self-header is how every other record addresses it, and how
         core's audit confirms one of its references landed where it claimed to.
         Exactly one per file, and in this repo it is record 3.`,
      ),
    ).toEqual([]);
  });

  test("the record names both other records exactly once", () => {
    const offenders = RECORDS.flatMap((record) => {
      if (record.number === null) return [];

      const numbers = record.references.map((reference) => reference.number);
      const expected = ALL_RECORD_NUMBERS.filter((n) => n !== record.number);

      if (new Set(numbers).size !== numbers.length) {
        return [
          `${record.path} — names ${JSON.stringify(numbers.sort())} — a sibling is ` +
            `referenced more than once`,
        ];
      }
      if (JSON.stringify([...numbers].sort()) !== JSON.stringify(expected)) {
        return [
          `${record.path} — is record ${record.number}/3 and names ` +
            `${JSON.stringify([...numbers].sort())}, but must name exactly ` +
            `${JSON.stringify(expected)}`,
        ];
      }
      return [];
    });

    expect(
      offenders,
      report(
        offenders,
        `Each record must name the other two — that is the entire deliverable
         here. A reader who lands on one copy of this decision learns the others
         exist ONLY from these lines; a record naming one sibling instead of two
         restores exactly the condition this task was opened to fix.`,
      ),
    ).toEqual([]);
  });

  test("the record does not cite itself as a sibling", () => {
    const offenders = RECORDS.flatMap((record) =>
      record.references
        .filter((reference) => reference.number === record.number)
        .map(
          (reference) =>
            `${record.path} (line ${reference.line}) — is record ${record.number}/3 and ` +
            `cites itself as a sibling: ${reference.raw}`,
        ),
    );

    expect(
      offenders,
      report(
        offenders,
        `A self-citation reads as a resolvable pointer and leads nowhere new. It
         is also what a half-finished renumbering looks like: the header moved
         and the reference list did not.`,
      ),
    ).toEqual([]);
  });

  test("every reference names a known repo and a source-shaped path", () => {
    const offenders = REFERENCES.flatMap((reference) => {
      if (!KNOWN_REPOS.includes(reference.repo)) {
        return [
          `${reference.record} (line ${reference.line}) — names repo \`${reference.repo}\`, ` +
            `which is not one of ${JSON.stringify(KNOWN_REPOS)}`,
        ];
      }
      if (!SOURCE_PATH_RE.test(reference.path)) {
        return [
          `${reference.record} (line ${reference.line}) — names \`${reference.path}\` in ` +
            `\`${reference.repo}\`, which is not shaped like a source file`,
        ];
      }
      return [];
    });

    expect(
      offenders,
      report(
        offenders,
        `A reference must name a repository this org knows and a path that looks
         like a source file. This is a SHAPE check — see the next test for what
         it deliberately does not do.`,
      ),
    ).toEqual([]);
  });

  // The mirror image of core's assertion 8, pointing the other way. Core says
  // "record 3 is in another repo, so I cannot resolve it"; from here BOTH
  // siblings are in another repo, so this side can resolve nothing at all.
  test("every reference is cross-repo — SHAPE ONLY, this audit resolves nothing", () => {
    // Filtered on the LOCAL repo token, not on `!== "core"`. Control 5 caught
    // the difference: written as "not core", a reference into
    // `openclaw-suite-channel` — a legitimate third repo this org knows — would
    // be reported as unresolved-but-resolvable, and so would a simple typo in
    // the repo token, which is test 4's finding and not this one's. "Is this
    // reference resolvable from HERE" is a question about THIS repo's name.
    const localReferences = REFERENCES.filter((reference) => reference.repo === LOCAL_REPO);

    expect(
      localReferences.map((reference) => `${reference.record}:${reference.line} ${reference.raw}`),
      `Both siblings of record 3 live in core, so every reference here is
       cross-repo and NOTHING in this file resolves. If a reference to a file in
       THIS repo ever appears, it must be resolved — path, anchor and reciprocal
       self-header — the way core's audit resolves its own, because from here
       that check is finally possible. Until then, green above means "shaped
       like a reference" and nothing more: not that record 1 or 2 exists, not
       that it is where the reference says, not that the anchor is in it.`,
    ).toEqual([]);
  });

  test("no citation carries a line pin", () => {
    const offenders = RECORDS.flatMap((record) =>
      record.citationLines
        .filter(({ text }) => LINE_PIN_RE.test(text))
        .map(({ line, text }) => `${record.path} (line ${line}) — line-pinned citation: ${text}`),
    );

    expect(
      offenders,
      report(
        offenders,
        `A citation must name an anchor, never a line number. Both pins this task
         found had already rotted, silently, and both still read as confident
         pointers: \`agent_responder.ex:485-487\` had drifted 47 lines into an
         unrelated comment block, and \`router.ex:1447\` no longer lands on the
         whitelist it names. Neither could be detected, because a line number
         records no expectation. Replace the pin with a \`§\` anchor naming the
         function or block — that either is in the target or is not.`,
      ),
    ).toEqual([]);
  });

  // ADDED AFTER THE TEST ABOVE WAS SHOWN TO MISS THE PINS THIS TASK EXISTS FOR.
  // Kept as a SEPARATE test rather than folded into it, so the two mechanisms
  // stay independently observable: a bare pin fails this one alone, a
  // repo-prefixed pin fails both, and either way the failing test name says
  // which selector caught it. Folding them together would have made the
  // narrower check unfalsifiable — it would never again fail alone.
  test("no line pin survives anywhere in the record, prefixed or bare", () => {
    const offenders = RECORDS.flatMap((record) =>
      record.pinnedLines.map(
        ({ line, text, pin }) => `${record.path} (line ${line}) — line pin \`${pin}\`: ${text}`,
      ),
    );

    expect(
      offenders,
      report(
        offenders,
        `A line pin is banned WHEREVER it appears in a record — in a citation, in
         prose, in a code comment beside the thing being described. The test
         above only ever inspected lines carrying a \`<repo>:\` token, and every
         pin this task actually found was bare, so the ban was enforced for the
         one shape that had not rotted here and silent about the one that had.

         Both of this record's original pins were bare: \`agent_responder.ex\`
         plus a line range that had drifted 47 lines into an unrelated comment
         block, and \`router.ex\` plus a line number that no longer lands on the
         whitelist it names. Both still read as confident pointers. Neither
         could be detected, because a line number records no expectation.

         THIS IS NOT AN INSTRUCTION TO DELETE THE SENTENCE. The record's account
         of what rotted is the evidence for the rule and must survive. Rewrite
         the pin into prose that names the file and the position separately —
         "was pinned into \`router.ex\` at line 1447" carries the identical
         forensic detail and is not a pointer anyone can follow into the wrong
         text. For a live pointer, use a \`§\` anchor naming the function or
         block.`,
      ),
    ).toEqual([]);
  });

  test("the record carries all four clause labels", () => {
    const offenders = RECORDS.filter((record) => record.missingLabels.length > 0).map(
      (record) =>
        `${record.path} — is missing ${record.missingLabels.map((l) => `\`${l}\``).join(", ")}`,
    );

    expect(
      offenders,
      report(
        offenders,
        `Every record states four things: what was DECIDED, WHY, WHAT WOULD
         RETIRE THIS, and the current RETIREMENT STATUS. The third is the
         falsifier and is the reason this audit exists — a decision recorded
         without one becomes an expired rule a reader has no way to recognise as
         expired, which is the exact failure this task was opened for.

         Add the missing clause. If the honest answer is "nothing would retire
         this", write that down — a stated permanence is a claim someone can
         argue with; an absent clause is not.`,
      ),
    ).toEqual([]);
  });

  // WEAKER THAN CORE'S RECIPROCITY ASSERTION, deliberately and visibly — the
  // anchor literal is restated here rather than read out of the referring
  // record, which is in the other repo. See the header.
  test("the record still sits above the anchor core's records cite for it", () => {
    const offenders = RECORDS.flatMap((record) => {
      if (record.path !== CORE_CITED_PATH) {
        return [
          `${record.path} — core's records cite record 3 at \`${CORE_CITED_PATH}\`; this ` +
            `record is in a different file, so both of core's references now point at ` +
            `nothing. Move the record back or update both core references.`,
        ];
      }
      const anchorIndex = record.source.indexOf(CORE_CITED_ANCHOR);
      if (anchorIndex < 0) {
        return [
          `${record.path} — does not contain \`${CORE_CITED_ANCHOR}\`, the anchor core's ` +
            `two records name for record 3`,
        ];
      }
      const anchorLine = record.source.slice(0, anchorIndex).split("\n").length;
      if (record.markerLine > anchorLine) {
        return [
          `${record.path} — the record starts at line ${record.markerLine}, below its own ` +
            `anchor at line ${anchorLine}; a record buried under the symbol it documents ` +
            `is not where a reader following the reference will land`,
        ];
      }
      return [];
    });

    expect(
      offenders,
      report(
        offenders,
        `Core's two records both point at \`${CORE_CITED_PATH} § makeEmitAttention\`. Core's
         own audit states that it cannot check this, so if it is not checked here
         it is not checked anywhere — and a cross-repo pointer that rots
         invisibly is the defect this task exists to remove.`,
      ),
    ).toEqual([]);
  });
});

describe("the audit itself", () => {
  // THE CONTROL. Every assertion above is a statement about a list, so all
  // eight pass against an empty corpus: rename the marker, break either regex,
  // or point the walk at the wrong root and this file goes green while guarding
  // nothing. Measured by control 6 in the header — under a marker rename this
  // is the ONLY failure.
  test("the scan is not vacuous", () => {
    expect(
      RECORDS.length,
      `the corpus walk found ${RECORDS.length} record file(s) under \`src/\`. Exactly
       one is expected. Either the marker was renamed, the walk is pointed at the
       wrong root, or the record was deleted — in all three cases every other
       assertion in this file is now passing against an empty list.`,
    ).toBeGreaterThanOrEqual(1);

    expect(
      RECORDS.map((record) => record.path),
      `more than one file in \`src/\` carries the marker. One decision recorded in
       more places than its readers know about is precisely the condition this
       task was opened about. If a second local record is legitimate, it must
       name every sibling, be named BY every sibling, and this count updated
       deliberately.`,
    ).toHaveLength(1);

    // Floored at ONE, not two, on purpose: arity is test 2's job, and an exact
    // floor here would fail twice for one defect with two explanations. This
    // asks only "did the reference grammar match anything at all".
    expect(
      REFERENCES.length,
      `the scan parsed ${REFERENCES.length} sibling references. The reference regex
       has stopped matching a corpus that is known to contain them — every
       reference assertion above just ran on an empty list.`,
    ).toBeGreaterThanOrEqual(1);

    // Asks whether ANY `core:` reference parsed, not whether all of them did:
    // control 5 breaks one repo token and this must still pass, or it is not a
    // control, it is a second copy of the assertion it is supposed to discriminate
    // against.
    expect(
      REFERENCES.some((reference) => reference.repo === "core"),
      `no \`core:\` reference was parsed (saw
       ${JSON.stringify([...new Set(REFERENCES.map((r) => r.repo))])}). Both siblings of
       record 3 are in core, so the shape assertions above ran on an empty or
       unrecognisable list.`,
    ).toBe(true);

    expect(
      RECORDS.every((record) => record.markerLine > 0),
      `a record file was selected by the marker but no line in it matches the
       marker regex — the two are out of step, which makes every line-scoped
       assertion above unreliable.`,
    ).toBe(true);
  });
});
