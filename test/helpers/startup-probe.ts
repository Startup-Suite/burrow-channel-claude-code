// Subprocess driver for the token-ref startup tests (task 01a0d6b9).
//
// Usage: bun test/helpers/startup-probe.ts <fake-security-path>
//
// Runs the plugin's REAL startup path — resolveStartupConfig(process.env) —
// with the keychain read pointed at a fake `security` (an injected path, the
// same seam the spec requires: never PATH), then hands the result to a real
// SuiteClient whose `phoenix` is a virtual fake, exactly as index.ts does.
//
// It prints ONE line on stdout: the sha256 of the token the socket was
// opened with, and the runtime id. NEVER the token. Everything the real
// modules log goes to stderr untouched, so the caller can grep both streams.
// With PROBE_PLANT=<marker> set it also writes that marker to stderr: the
// leak grep's positive control.

import { plugin } from "bun";
import { createHash } from "node:crypto";

const params: Array<{ token?: string; runtime_id?: string }> = [];

class FakePush {
  receive(): this {
    return this;
  }
}
class FakeChannel {
  on(): void {}
  push(): FakePush {
    return new FakePush();
  }
  join(): FakePush {
    return new FakePush();
  }
  leave(): void {}
}
class FakeSocket {
  constructor(_url: string, opts: { params?: { token?: string; runtime_id?: string } }) {
    params.push({ ...(opts.params ?? {}) });
  }
  channel(): FakeChannel {
    return new FakeChannel();
  }
  onOpen(): void {}
  onClose(): void {}
  onError(): void {}
  onMessage(): void {}
  isConnected(): boolean {
    return false;
  }
  connect(): void {}
  disconnect(): void {}
}

plugin({
  name: "startup-probe-fakes",
  setup(build) {
    build.module("phoenix", () => ({ loader: "object", exports: { Socket: FakeSocket, Channel: FakeChannel } }));
  },
});

const [securityBin] = process.argv.slice(2);
const { resolveStartupConfig, StartupError } = await import("../../src/startup-config.ts");
const { SuiteClient } = await import("../../src/suite-client.ts");

if (process.env.PROBE_PLANT) console.error(`planted: ${process.env.PROBE_PLANT}`);

let startup;
try {
  startup = await resolveStartupConfig(process.env, { platform: "darwin", ...(securityBin ? { securityBin } : {}) });
} catch (e) {
  console.error(`[claude-code-suite-channel] ${e instanceof StartupError ? e.message : "startup failed"}`);
  process.stdout.write(`${JSON.stringify({ ok: false, code: e instanceof StartupError ? e.code : "unknown" })}\n`);
  process.exit(1);
}

const client = new SuiteClient(
  { url: startup.url, runtimeId: startup.runtimeId, token: startup.token },
  { onAttention: () => {}, onDisconnect: () => {} },
);
client.connect();
client.disconnect();

const sent = params[0]?.token ?? "";
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    kind: startup.tokenKind,
    token_sha256: createHash("sha256").update(sent).digest("hex"),
    runtime_id: params[0]?.runtime_id ?? null,
  })}\n`,
);
