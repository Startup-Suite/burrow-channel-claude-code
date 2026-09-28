// Subprocess driver for the build-identity handshake tests.
//
// Usage: bun test/helpers/join-probe.ts <path/to/suite-client.ts> [<repo-to-commit-in-between-joins>]
//
// Loads a SuiteClient from an ARBITRARY copy of `src/` (so a test can load
// the module from a temp dir with no `.git`, or from a temp git repo), joins
// the runtime channel through a fake `phoenix`, and prints every captured
// `client_info` as one JSON line on stdout: `{ joins: [...], head_after }`.
//
// When a repo path is given, it commits to that repo AFTER the first join and
// BEFORE the second (a simulated rejoin on the same SuiteClient) - the case
// where a checkout moves under a resident process that has not restarted.
//
// `phoenix` is replaced with a virtual module via `Bun.plugin`, and bun
// resolves `ws` as a builtin, so the copied tree needs no node_modules.

import { plugin } from "bun";
import { execFileSync } from "node:child_process";

const captured: unknown[] = [];

class FakePush {
  receive(): this {
    return this;
  }
}

class FakeChannel {
  constructor(public topic: string, public params: { client_info?: unknown }) {
    captured.push(JSON.parse(JSON.stringify(params.client_info ?? null)));
  }
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
  channel(topic: string, params: { client_info?: unknown }): FakeChannel {
    return new FakeChannel(topic, params);
  }
  onOpen(): void {}
  onClose(): void {}
  onError(): void {}
  connect(): void {}
  disconnect(): void {}
}

plugin({
  name: "join-probe-fakes",
  setup(build) {
    build.module("phoenix", () => ({
      loader: "object",
      exports: { Socket: FakeSocket, Channel: FakeChannel },
    }));
  },
});

const [clientPath, commitRepo] = process.argv.slice(2);
if (!clientPath) throw new Error("usage: join-probe.ts <suite-client.ts> [repo]");

const { SuiteClient } = await import(clientPath);

const client = new SuiteClient(
  { url: "ws://localhost/socket", runtimeId: "probe", token: "t" },
  { onAttention: () => {}, onDisconnect: () => {} },
);

client.connect();

let headAfter: string | null = null;
if (commitRepo) {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", commitRepo, "-c", "user.email=probe@example.invalid", "-c", "user.name=probe", ...args],
      { encoding: "utf8" },
    ).trim();
  git("commit", "--allow-empty", "-q", "-m", "moved under a resident process");
  headAfter = git("rev-parse", "HEAD");
}

await new Promise((resolve) => setTimeout(resolve, 20));
client.connect();
client.disconnect();

process.stdout.write(JSON.stringify({ joins: captured, head_after: headAfter }) + "\n");
