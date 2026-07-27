// @ts-ignore phoenix ships without local type declarations
import { Socket, Channel } from "phoenix";
import WebSocket from "ws";
import pkg from "../package.json" with { type: "json" };
import { resetHistoryTracking } from "./attention.ts";

// Federation handshake: declare what client product is connecting so the Suite
// dispatch renderer can distinguish Claude-channel runtimes (one agent per
// connection — dispatch should suggest spawning a subagent for parallelism)
// from OpenClaw runtimes (which can host many agents per connection).
// Suite-side treats missing client_info as "unknown" (forward compatible).
export const CLIENT_INFO = {
  product: "claude_channel" as const,
  version: (pkg as { version?: string }).version ?? "unknown",
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
