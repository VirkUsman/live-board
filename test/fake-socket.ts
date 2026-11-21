import type { ClientMessage, ServerMessage } from "../src/shared/protocol.ts";

// A socket the test drives by hand: it opens, delivers and drops when told to.
export class FakeSocket {
  static instances: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.instances = [];
  }
  static last(): FakeSocket {
    const s = FakeSocket.instances.at(-1);
    if (!s) throw new Error("no socket was opened");
    return s;
  }

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  drop(): void {
    this.close();
  }

  messages(): ClientMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ClientMessage);
  }

  of<T extends ClientMessage["type"]>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.messages().filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);
  }
}

export const FakeImpl = FakeSocket as unknown as new (url: string) => WebSocket;
