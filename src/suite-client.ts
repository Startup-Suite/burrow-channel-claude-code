// @ts-ignore phoenix ships without local type declarations
import { Socket, Channel } from "phoenix";
import WebSocket from "ws";
import pkg from "../package.json" with { type: "json" };
import { resetHistoryTracking } from "./attention.ts";
import { normaliseFrame } from "./meeting-transcript.ts";
import type { MeetingTranscriptFrame } from "./meeting-transcript.ts";

// Federation handshake: declare what client product is connecting so the Suite
// dispatch renderer can distinguish Claude-channel runtimes (one agent per
// connection — dispatch should suggest spawning a subagent for parallelism)
// from OpenClaw runtimes (which can host many agents per connection).
// Suite-side treats missing client_info as "unknown" (forward compatible).
//
// ── `features` ─────────────────────────────────────────────────────────────
//
// A declared capability set: what THIS build can do, not what version it calls
// itself. Suite persists it on the runtime row (`runtime_channel.ex`
// `resolve_client_info/1`) and reads it back through
// `AgentRuntime.client_supports?/2`.
//
// WHY NOT `version`: the field directly above is derived from `package.json`,
// and `package.json` is not a function of the code that changed. Commit
// `7288017` — the fix that made responsibility dispatches render at all — did
// not bump it, so every runtime in the field reported `0.2.0` whether it was
// fixed or broken. The version discriminated nothing precisely when it was
// needed. This list is declared HERE, in the same module that types
// `AttentionPayload.signal.prompt` and pushes `client_info` on join below, so
// the claim ships in the same build as the behaviour it claims and cannot
// drift from it. It is deliberately NOT derived from `package.json`.
//
// Semantics on the server side, worth knowing before adding an entry:
//   - matching is EXACT. `system_event_prompt_v2`, `SYSTEM_EVENT_PROMPT` and a
//     space-padded variant are all rejected, so these strings are a wire
//     contract — never "tidy" one.
//   - fail-closed. Absence reads as "not proven", never as "broken": it covers
//     both an old build and a new build that has not reconnected yet.
//   - the persisted set is REPLACED on every join, not merged, so a downgrade
//     to a build without this line correctly revokes the claim.
//
// `system_event_prompt`: this build reads a responsibility dispatch's body
// from `signal.prompt` when the payload carries no `message` key at all
// (`attention.ts`, the `payload.message?.content ?? payload.signal?.prompt`
// fallback). Builds before `7288017` read `message.content` alone and
// delivered every one of those as an empty <channel> tag.
export const CLIENT_FEATURES = ["system_event_prompt"] as const;

export const CLIENT_INFO = {
  product: "claude_channel" as const,
  version: (pkg as { version?: string }).version ?? "unknown",
  features: CLIENT_FEATURES,
};

export interface SuiteConfig {
  url: string;
  runtimeId: string;
  token: string;
  reconnectIntervalMs?: number;
  maxReconnectIntervalMs?: number;
}

export interface AttentionPayload {
  signal: {
    reason: string;
    space_id?: string;
    task_id?: string;
    // Core lifts these to the root alongside `prompt` — `agent_responder.ex`
    // (`build_system_event_signal/2`) copies the responsibility's correlation
    // ids out of `metadata` so a federated runtime can read them without
    // digging. Both copies are sent, byte-equal; the root is the deliberate
    // named interface and `metadata` is the bag. Undeclared until now, which
    // is why `attention.ts` could only ever read the metadata copy of these
    // three while reading the root copy of `task_id` — see the resolution
    // loop's comment there.
    plan_id?: string;
    stage_id?: string;
    project_id?: string;
    task_status?: string;
    message_id?: string;
    // ── Responsibility dispatches (`reason: "system_event"`) ──────────────
    //
    // These carry NO `message` key at all. `agent_responder.ex:477`
    // (`build_system_event_signal/2`) builds the whole payload from the
    // responsibility context: the Router renders the prompt into
    // `metadata.prompt`, and line 493 lifts it to `signal.prompt` "so a
    // federated runtime can read `signal.prompt` without digging".
    prompt?: string;
    responsibility_key?: string;
    feature?: string;
    trigger_kind?: string;
    agent_id?: string;
    agent_slug?: string;
    // Correlation ids live in here, not at the top level — see
    // `router.ex:1447` (`@native_trigger_scalar_keys`). Deliberately typed
    // `unknown` so nothing reads it without narrowing: it also holds the
    // full rendered prompt, and on the chat path a frozen history snapshot.
    metadata?: Record<string, unknown>;
  };
  // OPTIONAL. Typing this as required is why the client assumed it existed
  // and read `message.content` unconditionally, which made every
  // responsibility dispatch arrive as an empty <channel> tag.
  message?: { content: string; author: string; author_id?: string };
  history?: Array<{ content: string; author: string; role?: string }>;
  context?: Record<string, unknown>;
}

/**
 * Everything that identifies an attention event, for the ~1s dedupe window.
 *
 * The old key was `space_id:message_id:bucket`. A responsibility dispatch has
 * neither field — `space_id` isn't in `build_system_event_signal/2` and
 * `message_id` is chat-only — so it degraded to `"::<bucket>"` and ANY two
 * dispatches landing in the same second collapsed into one. Latent until the
 * `signal.prompt` fallback made these payloads reachable at all; shipping that
 * fix without this one would have traded blank wake-ups for dropped ones.
 *
 * Every added component can only make the key MORE unique, never less, so a
 * genuine Suite retry (byte-identical payload) still collapses exactly as
 * before. Dedupe erring open is the safe direction: a duplicate wake-up is
 * visible and annoying, a dropped dispatch is silent.
 */
export function attentionIdentity(payload: AttentionPayload): string {
  const signal = payload.signal;
  const metadata = signal?.metadata ?? {};
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  return [
    signal?.space_id ?? "",
    signal?.message_id ?? "",
    signal?.responsibility_key ?? "",
    str(metadata.task_id),
    str(metadata.plan_id),
    str(metadata.stage_id),
    payload.message?.content?.slice(0, 50) ?? signal?.prompt?.slice(0, 50) ?? "",
  ].join(":");
}

export interface PermissionVerdict {
  request_id: string;
  behavior: "allow" | "deny";
}

export interface SuiteHandlers {
  onAttention: (payload: AttentionPayload) => void;
  onDisconnect: () => void;
  // One final meeting transcript segment (`meeting_transcript` event). Typed
  // loosely on purpose: core may add keys, and a malformed frame must be
  // dropped by the handler, never thrown at from here.
  onMeetingTranscript?: (frame: MeetingTranscriptFrame | Record<string, unknown>) => void;
  onSpacesManifest?: (spaces: Array<{ id: string; name: string; kind: string }>) => void;
  onPermissionVerdict?: (verdict: PermissionVerdict) => void;
}

const DEFAULT_RECONNECT_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;

// Dead-man watchdog: a healthy Phoenix socket carries traffic at least every
// heartbeat interval (30s — heartbeat replies count), so prolonged total
// silence means the connection is dead even if the client still believes it
// is open (laptop sleep, NAT timeout, half-open TCP). The watchdog forces a
// reconnect when the socket reports disconnected or has been silent past the
// stale threshold.
const WATCHDOG_INTERVAL_MS = 30_000;
const STALE_TRAFFIC_MS = 120_000;

function log(msg: string): void {
  console.error(`[suite-client ${new Date().toISOString()}] ${msg}`);
}

/**
 * Phoenix WebSocket client for a Suite runtime connection. Adapted from
 * startup-suite-channel (the OpenClaw plugin). This version is scoped down to
 * what the Claude Code channel needs: attention events in, replies / media /
 * typing / presence out. No tool surface.
 */
export class SuiteClient {
  private socket: Socket | null = null;
  private channel: Channel | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastTrafficAt = Date.now();
  private stopped = false;
  private recentMessageIds = new Set<string>();

  constructor(
    private readonly config: SuiteConfig,
    private readonly handlers: SuiteHandlers,
  ) {}

  connect(): void {
    this.stopped = false;

    // Fresh socket session: re-arm per-space history injection so attentions
    // we may have missed during a disconnect can re-bring history into the
    // Claude session.
    resetHistoryTracking();

    if (this.channel) {
      try { this.channel.leave(); } catch { /* noop */ }
      this.channel = null;
    }
    if (this.socket) {
      try { this.socket.disconnect(); } catch { /* noop */ }
      this.socket = null;
    }

    // Phoenix client needs a WebSocket implementation in Node/Bun
    (globalThis as any).WebSocket = WebSocket;

    this.socket = new Socket(this.config.url, {
      params: {
        runtime_id: this.config.runtimeId,
        token: this.config.token,
      },
      reconnectAfterMs: () => 999_999_999, // we handle reconnect ourselves
    });

    this.lastTrafficAt = Date.now();
    log(`connecting to ${this.config.url} (attempt ${this.reconnectAttempts + 1})`);

    this.socket.onOpen(() => {
      log("socket open");
      this.lastTrafficAt = Date.now();
    });

    this.socket.onClose((event: any) => {
      if (!this.stopped) {
        log(`socket closed (code=${event?.code ?? "?"} reason=${event?.reason || "n/a"})`);
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      }
    });

    this.socket.onError((err: any) => {
      if (!this.stopped) {
        log(`socket error: ${err?.message ?? err}`);
        this.handlers.onDisconnect();
        // Some failure modes (rejected upgrade, DNS, half-open TCP) surface
        // as an error without a matching close event — re-enter the
        // reconnect loop from here too. scheduleReconnect dedupes, so an
        // error followed by a close only arms one timer.
        this.scheduleReconnect();
      }
    });

    // Heartbeat replies and channel events both land here; any traffic at
    // all proves the connection is alive. Defensive call: test shims may
    // not implement onMessage.
    (this.socket as any).onMessage?.(() => {
      this.lastTrafficAt = Date.now();
    });

    // The watchdog must be armed even if the dial below throws, so a
    // synchronous connect failure on the FIRST attempt (DNS down at boot,
    // bad URL) still enters the retry loop instead of leaving the client
    // permanently idle.
    this.startWatchdog();

    try {
      this.socket.connect();
      this.joinChannel();
    } catch (err) {
      log(`connect failed synchronously: ${err instanceof Error ? err.message : err}`);
      this.handlers.onDisconnect();
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.channel?.leave();
    this.channel = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  sendReply(spaceId: string, content: string): void {
    this.channel?.push("reply", { space_id: spaceId, content });
  }

  sendTyping(spaceId: string, typing: boolean): void {
    this.channel?.push("typing", { space_id: spaceId, typing });
  }

  sendReplyChunk(spaceId: string, chunkId: string, text: string, done: boolean): void {
    this.channel?.push("reply_chunk", {
      space_id: spaceId,
      chunk_id: chunkId,
      text,
      done,
    });
  }

  sendReplyWithMedia(
    spaceId: string,
    content: string,
    attachments: Array<{ filename: string; contentType: string; data: string }>,
  ): void {
    this.channel?.push("reply_with_media", {
      space_id: spaceId,
      content,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content_type: a.contentType,
        data: a.data,
      })),
    });
  }

  private joinChannel(): void {
    if (!this.socket) return;

    const topic = `runtime:${this.config.runtimeId}`;
    this.channel = this.socket.channel(topic, {
      client_info: CLIENT_INFO,
    });

    this.channel.on("attention", (payload: AttentionPayload) => {
      const dedupeKey = `${attentionIdentity(payload)}:${Date.now() >> 10}`;
      if (this.recentMessageIds.has(dedupeKey)) return;
      this.recentMessageIds.add(dedupeKey);
      if (this.recentMessageIds.size > 50) {
        const first = this.recentMessageIds.values().next().value;
        if (first) this.recentMessageIds.delete(first);
      }
      this.handlers.onAttention(payload);
    });

    // Meeting transcript segments. No dedupe here: core guarantees one frame
    // per final segment and `segment_id` is stable, and the coalescing in
    // `meeting-transcript.ts` needs every frame it is going to join.
    //
    // ── `meeting_transcript_ack` ────────────────────────────────────────────
    //
    // Core's `RuntimePresence.prove/2` stamps a capability proven only from an
    // INBOUND frame; recording its own outbound broadcast would be core
    // certifying its own send, which is the inversion the mechanism exists to
    // remove. `meeting_transcript` had no inbound frame at all, so its
    // `proven` cell read `never` for every runtime forever — including ones
    // that demonstrably could hear. This ack is that missing inbound frame.
    //
    // Two properties it must keep, or it is worse than nothing:
    //
    //   1. ONLY for a frame that really arrived and really validates. It is
    //      gated on `normaliseFrame` — the same and only check the delivery
    //      path applies — so a frame that is dropped (no text, no room_name)
    //      produces NO ack. An ack without a delivered segment would turn an
    //      honest-empty cell into a false positive.
    //   2. SYNCHRONOUS, here in the channel handler. It is a receipt for the
    //      raw inbound frame, deliberately decoupled from the 1.5s coalescing
    //      window in `meeting-transcript.ts`: the agent's session sees a
    //      coalesced burst up to `COALESCE_WINDOW_MS` later, and proof of
    //      reception should not wait on that, nor be lost if the socket dies
    //      mid-burst.
    //
    // `build` is `CLIENT_INFO.version` (the `package.json` string already sent
    // in `client_info` at join) — the only build identifier this plugin has.
    // Its known weakness is documented on `CLIENT_FEATURES` above: the version
    // is not a function of the code, so it discriminates coarsely. It is sent
    // because a proof with a build tag is strictly more useful than one
    // without, not because it is precise.
    this.channel.on("meeting_transcript", (frame: Record<string, unknown>) => {
      const valid = normaliseFrame(frame);
      if (valid) {
        this.channel?.push("meeting_transcript_ack", {
          segment_id: valid.segment_id,
          room_name: valid.room_name,
          build: CLIENT_INFO.version,
        });
      }
      this.handlers.onMeetingTranscript?.(frame);
    });

    this.channel.on("spaces_manifest", (payload: { spaces: Array<{ id: string; name: string; kind: string }> }) => {
      this.handlers.onSpacesManifest?.(payload.spaces);
    });

    this.channel.on("ping", (_payload: { timestamp?: string }) => {
      this.channel?.push("pong", { timestamp: new Date().toISOString() });
    });

    // Optional: Suite may deliver remote verdicts via a dedicated event.
    // Kept here so the channel is ready to consume if/when Suite adds it.
    this.channel.on("permission_verdict", (payload: PermissionVerdict) => {
      this.handlers.onPermissionVerdict?.(payload);
    });

    this.channel
      .join()
      .receive("ok", () => {
        log(`joined ${topic}`);
        // Join success — not socket open — is the real "we're back":
        // reset the backoff here so a flaky join doesn't shrink delays.
        this.reconnectAttempts = 0;
        this.lastTrafficAt = Date.now();
      })
      .receive("error", (reason: unknown) => {
        // A rejected join (stale token, runtime deregistered, server-side
        // crash) previously logged once and left inbound dead forever while
        // the socket looked healthy. Treat it as a disconnect and keep
        // retrying with backoff.
        log(`failed to join ${topic}: ${JSON.stringify(reason)} — scheduling reconnect`);
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      })
      .receive("timeout", () => {
        log(`join ${topic} timed out — scheduling reconnect`);
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      });
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(() => {
      if (this.stopped || this.reconnectTimer) return;

      const silentMs = Date.now() - this.lastTrafficAt;
      const connected = (this.socket as any)?.isConnected?.() ?? false;

      if (!connected || silentMs > STALE_TRAFFIC_MS) {
        log(
          `watchdog: unhealthy (connected=${connected}, silent=${Math.round(silentMs / 1000)}s) — forcing reconnect`,
        );
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const base = this.config.reconnectIntervalMs ?? DEFAULT_RECONNECT_MS;
    const max = this.config.maxReconnectIntervalMs ?? DEFAULT_MAX_RECONNECT_MS;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts), max);

    log(`reconnect scheduled in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      try {
        this.connect();
      } catch (err) {
        // A synchronous connect failure (e.g. WebSocket constructor throw)
        // must not end the loop.
        log(`connect threw: ${err instanceof Error ? err.message : err} — rescheduling`);
        this.scheduleReconnect();
      }
    }, delay);
  }
}
