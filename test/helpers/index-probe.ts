// Subprocess driver for test/env-fallback.test.ts.
//
// Usage: PROBE_OUT=<file> bun test/helpers/index-probe.ts <path/to/src/index.ts>
//
// Loads the REAL plugin entry point (src/index.ts) the way Claude Code
// launches it, with `phoenix` replaced by a fake that records what the socket
// would dial and which topic it joins. The record goes to the file named by
// PROBE_OUT, NOT stdout: stdout is the MCP stdio transport, and the test
// asserts this process writes nothing to it at all.
//
// When index.ts exits on its own (missing env), no record is written and the
// exit code is the plugin's.

import { plugin } from "bun";
import { writeFileSync } from "node:fs";

type Record_ = {
  sockets: Array<{ url: string; params: unknown }>;
  joins: Array<{ topic: string; client_info: unknown }>;
};

const record: Record_ = { sockets: [], joins: [] };

class FakePush {
  receive(): this {
    return this;
  }
}

class FakeChannel {
  constructor(public topic: string, params: { client_info?: unknown }) {
    record.joins.push({ topic, client_info: JSON.parse(JSON.stringify(params.client_info ?? null)) });
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
  constructor(url: string, opts: { params?: unknown }) {
    record.sockets.push({ url, params: JSON.parse(JSON.stringify(opts?.params ?? null)) });
  }
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
  name: "index-probe-fakes",
  setup(build) {
    build.module("phoenix", () => ({
      loader: "object",
      exports: { Socket: FakeSocket, Channel: FakeChannel },
    }));
  },
});

const [indexPath] = process.argv.slice(2);
const out = process.env.PROBE_OUT;
if (!indexPath || !out) {
  console.error("usage: PROBE_OUT=<file> index-probe.ts <src/index.ts>");
  process.exit(2);
}

await import(indexPath);
await new Promise((resolve) => setTimeout(resolve, 20));

writeFileSync(out, JSON.stringify(record));
process.exit(0);
