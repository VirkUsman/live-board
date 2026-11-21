export const COLUMNS = ["todo", "doing", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export interface Card {
  id: string;
  title: string;
  column: Column;
  version: number;
  // The sequence number of the event that created the card, used for ordering.
  n: number;
}

export interface User {
  id: string;
  name: string;
}

export type BoardEvent =
  | { seq: number; type: "card.created"; card: Card; by: string; at: number }
  | { seq: number; type: "card.moved"; card: Card; from: Column; by: string; at: number }
  | { seq: number; type: "card.renamed"; card: Card; by: string; at: number };

export type ClientMessage =
  | { type: "hello"; board: string; user: User; lastSeq: number | null }
  | { type: "create"; reqId: string; id: string; title: string; column: Column }
  | { type: "move"; reqId: string; id: string; column: Column; baseVersion: number }
  | { type: "rename"; reqId: string; id: string; title: string; baseVersion: number };

export type RejectReason = "version" | "missing" | "exists";

export type ServerMessage =
  | { type: "snapshot"; seq: number; cards: Card[] }
  | { type: "event"; event: BoardEvent }
  | { type: "ack"; reqId: string; seq: number }
  | { type: "rejected"; reqId: string; reason: RejectReason; card?: Card }
  | { type: "presence"; users: User[] }
  | { type: "error"; message: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD = /^[A-Za-z0-9_-]{1,40}$/;

export function isColumn(v: unknown): v is Column {
  return typeof v === "string" && (COLUMNS as readonly string[]).includes(v);
}

function isTitle(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 120;
}

function isVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

export type Parsed = { ok: true; message: ClientMessage } | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });

export function parseClientMessage(raw: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail("not json");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return fail("not an object");
  const m = data as Record<string, unknown>;

  if (m.type === "hello") {
    if (typeof m.board !== "string" || !BOARD.test(m.board)) return fail("bad board id");
    const u = m.user as Record<string, unknown> | null;
    if (typeof u !== "object" || u === null) return fail("bad user");
    if (typeof u.id !== "string" || !ID.test(u.id)) return fail("bad user id");
    if (typeof u.name !== "string" || u.name.trim().length < 1 || u.name.length > 40) return fail("bad user name");
    const last = m.lastSeq;
    if (last !== null && !(typeof last === "number" && Number.isInteger(last) && last >= 0)) return fail("bad lastSeq");
    return { ok: true, message: { type: "hello", board: m.board, user: { id: u.id, name: u.name.trim() }, lastSeq: last } };
  }

  if (m.type === "create" || m.type === "move" || m.type === "rename") {
    if (typeof m.reqId !== "string" || !ID.test(m.reqId)) return fail("bad reqId");
    if (typeof m.id !== "string" || !ID.test(m.id)) return fail("bad card id");
    if (m.type === "create") {
      if (!isTitle(m.title)) return fail("bad title");
      if (!isColumn(m.column)) return fail("bad column");
      return { ok: true, message: { type: "create", reqId: m.reqId, id: m.id, title: (m.title as string).trim(), column: m.column } };
    }
    if (!isVersion(m.baseVersion)) return fail("bad baseVersion");
    if (m.type === "move") {
      if (!isColumn(m.column)) return fail("bad column");
      return { ok: true, message: { type: "move", reqId: m.reqId, id: m.id, column: m.column, baseVersion: m.baseVersion } };
    }
    if (!isTitle(m.title)) return fail("bad title");
    return { ok: true, message: { type: "rename", reqId: m.reqId, id: m.id, title: (m.title as string).trim(), baseVersion: m.baseVersion } };
  }
  return fail("unknown type");
}
