import type { ClientMessage, ServerMessage, User } from "../shared/protocol.ts";

export type Status = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionOptions {
  url: string;
  board: string;
  user: User;
  // null until a snapshot has been applied, then the last sequence number applied
  getLastSeq: () => number | null;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: Status) => void;
  WebSocketImpl?: new (url: string) => WebSocket;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
}

export class LiveConnection {
  private ws: WebSocket | undefined;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(private readonly opts: ConnectionOptions) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = undefined;
    this.opts.onStatus("closed");
  }

  // Drop the socket and let the normal reconnect path ask for what was missed.
  reconnect(): void {
    this.ws?.close();
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  delayFor(attempt: number): number {
    const base = this.opts.reconnectBaseMs ?? 250;
    const max = this.opts.reconnectMaxMs ?? 5000;
    const rand = (this.opts.random ?? Math.random)();
    return Math.round(Math.min(max, base * 2 ** attempt) * (0.5 + rand / 2));
  }

  private open(): void {
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    this.opts.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new Impl(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      const hello: ClientMessage = {
        type: "hello",
        board: this.opts.board,
        user: this.opts.user,
        lastSeq: this.opts.getLastSeq(),
      };
      ws.send(JSON.stringify(hello));
      this.opts.onStatus("open");
    };
    ws.onmessage = (e: MessageEvent) => {
      this.attempt = 0;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
      this.opts.onStatus("reconnecting");
      const wait = this.delayFor(this.attempt);
      this.attempt++;
      this.timer = setTimeout(() => this.open(), wait);
    };
    ws.onerror = () => undefined;
  }
}
