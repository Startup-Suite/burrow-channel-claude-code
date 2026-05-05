// @ts-ignore phoenix ships without local type declarations
import { Socket, Channel } from "phoenix";
import WebSocket from "ws";
import pkg from "../package.json" with { type: "json" };

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
  };
  message: { content: string; author: string; author_id?: string };
  history?: Array<{ content: string; author: string; role?: string }>;
  context?: Record<string, unknown>;
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
  private stopped = false;
  private recentMessageIds = new Set<string>();

  constructor(
    private readonly config: SuiteConfig,
    private readonly handlers: SuiteHandlers,
  ) {}

  connect(): void {
    this.stopped = false;

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

    this.socket.onOpen(() => {
      this.reconnectAttempts = 0;
    });

    this.socket.onClose((event: any) => {
      if (!this.stopped) {
        this.handlers.onDisconnect();
        this.scheduleReconnect();
      }
    });

    this.socket.onError((_err: any) => {
      if (!this.stopped) this.handlers.onDisconnect();
    });

    this.socket.connect();
    this.joinChannel();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
      const msgId = payload.signal?.message_id ?? payload.message?.content?.slice(0, 50) ?? "";
      const dedupeKey = `${payload.signal?.space_id ?? ""}:${msgId}:${Date.now() >> 10}`;
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
        console.error(`[suite-client] joined ${topic}`);
      })
      .receive("error", (reason: unknown) => {
        console.error(`[suite-client] failed to join ${topic}:`, reason);
      });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const base = this.config.reconnectIntervalMs ?? DEFAULT_RECONNECT_MS;
    const max = this.config.maxReconnectIntervalMs ?? DEFAULT_MAX_RECONNECT_MS;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts), max);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      this.connect();
    }, delay);
  }
}
