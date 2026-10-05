// spec/token-ref-vectors.json (vendored from suite-cli, pinned by
// spec/token-ref-vectors.pin, diffed by scripts/check-token-ref-vectors.sh),
// run against src/token-ref.ts.
//
// This plugin is a LEGACY consumer (spec "Literals"): a literal SUITE_TOKEN is
// passed through unchanged; every ref is resolved or refused exactly as the
// vectors say. Values are fresh random canaries, never printed, and every
// refusal message is scanned for them.

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECURITY_BIN, TokenRefError, resolveToken, securityArgs } from "../src/token-ref.ts";

interface Vector {
  id: string;
  ref: string;
  keychain_service: string | null;
  platform: NodeJS.Platform;
  file?: { kind: "regular" | "symlink" | "absent"; mode?: string; owner?: "caller" | "other"; content?: string };
  security?: { exit: number; stdout: string } | null;
  expect: { outcome: "resolved" | "refused" | "literal"; kind: string; value?: string; code?: string; names?: string[]; security_args?: string[] };
}

const SPEC = JSON.parse(readFileSync(join(import.meta.dir, "..", "spec", "token-ref-vectors.json"), "utf8")) as {
  spec_version: number;
  security: { bin: string; args: string[] };
  vectors: Vector[];
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const canary = () => `vec_01a0d6b9_${randomBytes(20).toString("hex")}`;

describe(`spec/token-ref-vectors.json v${SPEC.spec_version} (vendored)`, () => {
  test("anti-vacuity: vectors exist and cover every outcome", () => {
    expect(SPEC.vectors.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(SPEC.vectors.map((v) => v.expect.outcome))].sort()).toEqual(["literal", "refused", "resolved"]);
  });

  test("the pinned resolver argv is the one this plugin builds", () => {
    expect(SPEC.security.bin).toBe(SECURITY_BIN);
    expect(securityArgs("{service}", "{item}")).toEqual(SPEC.security.args);
  });

  for (const v of SPEC.vectors) {
    test(`${v.id}: ${v.expect.outcome}${v.expect.code ? ` ${v.expect.code}` : ""}`, async () => {
      const value = canary();
      const dir = mkdtempSync(join(tmpdir(), `channel-vectors-01a0d6b9-${process.pid}-`));
      dirs.push(dir);
      const fill = (s: string) => s.replaceAll("{dir}", dir).replaceAll("{value}", value);
      const tokenPath = join(dir, "runtime.token");
      if (v.file !== undefined && v.file.kind !== "absent") {
        const target = v.file.kind === "symlink" ? join(dir, "real.token") : tokenPath;
        writeFileSync(target, fill(v.file.content ?? ""));
        chmodSync(target, Number.parseInt(v.file.mode ?? "0600", 8));
        if (v.file.kind === "symlink") symlinkSync(target, tokenPath);
      }
      const me = process.getuid?.() ?? 0;
      const calls: string[][] = [];
      let got: { ok: true; kind: string; value: string } | { ok: false; code: string; message: string };
      try {
        const r = await resolveToken(fill(v.ref), v.keychain_service ?? undefined, {
          platform: v.platform,
          uid: v.file?.owner === "other" ? me + 1 : me,
          exec: async (bin, args) => {
            calls.push([bin, ...args]);
            if (v.security === undefined || v.security === null) throw new Error(`vector ${v.id} did not expect security`);
            return { exitCode: v.security.exit, stdout: fill(v.security.stdout) };
          },
        });
        got = { ok: true, kind: r.kind, value: r.value };
      } catch (e) {
        if (!(e instanceof TokenRefError)) throw e;
        got = { ok: false, code: e.code, message: e.message };
      }
      switch (v.expect.outcome) {
        case "resolved":
          expect(got.ok).toBe(true);
          if (got.ok) {
            expect(got.kind).toBe(v.expect.kind);
            expect(got.value).toBe(fill(v.expect.value ?? ""));
          }
          break;
        case "literal":
          // Legacy consumer: the literal passes through unchanged.
          expect(got).toEqual({ ok: true, kind: "literal", value: fill(v.ref) });
          break;
        case "refused":
          expect(got.ok).toBe(false);
          if (!got.ok) {
            expect(got.code).toBe(v.expect.code as string);
            for (const n of v.expect.names ?? []) expect(got.message).toContain(n);
            expect(got.message.includes(value)).toBe(false);
          }
          break;
        default:
          throw new Error(`unknown outcome in vector ${v.id}`);
      }
      if (v.expect.security_args !== undefined) {
        expect(calls).toEqual([[SPEC.security.bin, ...v.expect.security_args]]);
        expect(calls.flat().join(" ").includes(value)).toBe(false);
      }
    });
  }
});
