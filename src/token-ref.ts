/**
 * SUITE_TOKEN as a token REF, resolved at startup, in memory.
 *
 * The syntax and every refusal are defined ONCE, in suite-cli's
 * `spec/token-ref.md`, and pinned here by `spec/token-ref-vectors.json`
 * (vendored, diffed against its suite-cli commit by
 * `scripts/check-token-ref-vectors.sh`):
 *
 *   SUITE_TOKEN=keychain:<item>   + SUITE_TOKEN_KEYCHAIN_SERVICE=<service>   (macOS)
 *   SUITE_TOKEN=file:<absolute path>                    (regular, yours, 0600/0400)
 *   SUITE_TOKEN=<literal>                               still works (legacy)
 *
 * A keychain item is read with exactly
 *   /usr/bin/security find-generic-password -s <service> -a <item> -w
 * — absolute path, no shell, NAMES only in argv; the value arrives on the
 * child's stdout. A `security` earlier on PATH cannot answer for the keychain.
 * Tests reach a fake through {@link TokenRefDeps}, never through PATH.
 *
 * Every error names the ref, the item, the service, the path or the mode. No
 * error, and no log line, ever carries a resolved value or a literal token.
 */
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const FILE_PREFIX = "file:";
export const KEYCHAIN_PREFIX = "keychain:";
export const SECURITY_BIN = "/usr/bin/security";

export type TokenKind = "file" | "keychain" | "literal";

/** A refusal with a spec code. The message is safe to print. */
export class TokenRefError extends Error {
  readonly code: string;
  readonly kind: TokenKind | "unknown";
  constructor(code: string, kind: TokenKind | "unknown", message: string) {
    super(message);
    this.name = "TokenRefError";
    this.code = code;
    this.kind = kind;
  }
}

export interface TokenRefDeps {
  platform?: NodeJS.Platform;
  /** The caller's uid; a seam so the foreign-owner case needs no root. */
  uid?: number;
  /** Absolute path of `security`. Only tests change it. */
  securityBin?: string;
  /** Runs `bin` with `args`, no shell. */
  exec?: (bin: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>;
}

/** The argv of the keychain read. Names only; identical to suite-cli's and openclaw's. */
export function securityArgs(service: string, item: string): string[] {
  return ["find-generic-password", "-s", service, "-a", item, "-w"];
}

/** spec/token-ref.md "Syntax": one plain word. */
export function isValidItem(item: string): boolean {
  return item !== "" && !/[\s\x00-\x1f\x7f]/.test(item);
}

/** The scheme of a scheme-shaped string that is not ours, or null. */
export function unknownScheme(raw: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  if (m === null) return null;
  const scheme = `${m[1]}:`;
  return scheme === FILE_PREFIX || scheme === KEYCHAIN_PREFIX ? null : scheme;
}

function stripOneNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function execNoShell(bin: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: "utf8", shell: false, timeout: 15_000 }, (error, stdout) => {
      if (error === null) return resolve({ exitCode: 0, stdout: String(stdout) });
      const code = (error as { code?: unknown }).code;
      // stdout of a failed call is discarded: it is never a value we trust.
      resolve({ exitCode: typeof code === "number" ? code : -1, stdout: "" });
    });
  });
}

/** What a SUITE_TOKEN string is, before anything is read. Throws on a refusal. */
export function classifyToken(raw: string): TokenKind {
  if (raw.startsWith(FILE_PREFIX)) return "file";
  if (raw.startsWith(KEYCHAIN_PREFIX)) return "keychain";
  const scheme = unknownScheme(raw);
  if (scheme !== null) {
    throw new TokenRefError("token_ref_unknown_scheme", "unknown", `unknown token ref scheme ${JSON.stringify(scheme)}; use keychain:<item> or file:<absolute path>`);
  }
  return "literal";
}

/**
 * Resolve SUITE_TOKEN to the runtime token, IN MEMORY. A literal is returned
 * as it is (a legacy consumer, spec "Literals"). Never log the return value.
 */
export async function resolveToken(raw: string, keychainService: string | undefined, deps: TokenRefDeps = {}): Promise<{ kind: TokenKind; value: string }> {
  const kind = classifyToken(raw);
  if (kind === "literal") return { kind, value: raw };

  if (kind === "file") {
    const path = raw.slice(FILE_PREFIX.length);
    if (!isAbsolute(path)) throw new TokenRefError("token_ref_invalid", "file", `file: refs need an absolute path, got ${JSON.stringify(path)}`);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      throw new TokenRefError("token_file_missing", "file", `token file ${path} does not exist or cannot be stat'ed`);
    }
    if (!st.isFile()) throw new TokenRefError("token_file_not_regular", "file", `token file ${path} is not a regular file (symlinks are refused)`);
    const uid = deps.uid ?? process.getuid?.() ?? -1;
    if (st.uid !== uid) throw new TokenRefError("token_file_foreign_owner", "file", `token file ${path} is owned by uid ${st.uid}, not by this process (uid ${uid})`);
    const perm = st.mode & 0o777;
    if (perm !== 0o600 && perm !== 0o400) {
      throw new TokenRefError("token_file_mode", "file", `token file ${path} has mode ${modeString(st.mode)}; it must be 0600 or 0400`);
    }
    const value = stripOneNewline(readFileSync(path, "utf8"));
    if (value === "") throw new TokenRefError("token_file_empty", "file", `token file ${path} is empty`);
    return { kind, value };
  }

  const item = raw.slice(KEYCHAIN_PREFIX.length);
  if (item === "") throw new TokenRefError("token_ref_invalid", "keychain", "keychain: refs need an item name");
  if (!isValidItem(item)) {
    throw new TokenRefError("token_ref_invalid", "keychain", `keychain item ${JSON.stringify(item)} contains whitespace or a control character`);
  }
  const service = keychainService ?? "";
  if (service === "") throw new TokenRefError("keychain_service_missing", "keychain", `keychain:${item} needs SUITE_TOKEN_KEYCHAIN_SERVICE`);
  if ((deps.platform ?? process.platform) !== "darwin") {
    throw new TokenRefError("keychain_unsupported_platform", "keychain", `keychain:${item}: keychain refs are macOS-only`);
  }
  const bin = deps.securityBin ?? SECURITY_BIN;
  const r = await (deps.exec ?? execNoShell)(bin, securityArgs(service, item));
  const value = r.exitCode === 0 ? stripOneNewline(r.stdout) : "";
  if (value === "") {
    throw new TokenRefError(
      "keychain_unavailable",
      "keychain",
      `the keychain did not return item ${JSON.stringify(item)} of service ${JSON.stringify(service)} (security exit ${r.exitCode}); unlock the login keychain or add the item`,
    );
  }
  return { kind, value };
}
