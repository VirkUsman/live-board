import { Redis } from "ioredis";
import type { BoardEvent, Card, Column, RejectReason } from "../shared/protocol.ts";

// One script does the version check, the write, the sequence number, the log
// append and the publish. Running as one unit is what makes the sequence
// gap free and keeps the published order the same as the log order, even with
// several server instances writing at once.
const MUTATE = `
local kind = ARGV[2]
local id = ARGV[3]
local raw = redis.call('HGET', KEYS[1], id)
local card
local from
if kind == 'create' then
  if raw then return cjson.encode({err = 'exists', card = cjson.decode(raw)}) end
  card = {id = id, title = ARGV[5], column = ARGV[4], version = 1, n = 0}
else
  if not raw then return cjson.encode({err = 'missing'}) end
  card = cjson.decode(raw)
  if card.version ~= tonumber(ARGV[6]) then return cjson.encode({err = 'version', card = card}) end
  if kind == 'move' then
    from = card.column
    card.column = ARGV[4]
  else
    card.title = ARGV[5]
  end
  card.version = card.version + 1
end
local seq = redis.call('INCR', KEYS[2])
if kind == 'create' then card.n = seq end
redis.call('HSET', KEYS[1], id, cjson.encode(card))
local ev = {seq = seq, type = 'card.' .. ARGV[9], card = card, by = ARGV[7], at = tonumber(ARGV[8])}
if from then ev.from = from end
redis.call('RPUSH', KEYS[3], cjson.encode(ev))
redis.call('PUBLISH', ARGV[1], tostring(seq))
return cjson.encode({ok = true, event = ev})
`;

const SNAPSHOT = `
local seq = tonumber(redis.call('GET', KEYS[2]) or '0')
local flat = redis.call('HVALS', KEYS[1])
return {tostring(seq), flat}
`;

export type MutateResult =
  | { ok: true; event: BoardEvent }
  | { ok: false; reason: RejectReason; card?: Card };

export interface Mutation {
  kind: "create" | "move" | "rename";
  id: string;
  column?: Column;
  title?: string;
  baseVersion?: number;
}

const PAGE = 200;

export class BoardStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  keys(board: string) {
    const b = `${this.prefix}:${board}`;
    return {
      cards: `${b}:cards`,
      seq: `${b}:seq`,
      log: `${b}:log`,
      events: `${b}:events`,
      presence: `${b}:presence`,
      presenceChange: `${b}:presencechange`,
    };
  }

  async mutate(board: string, by: string, m: Mutation): Promise<MutateResult> {
    const k = this.keys(board);
    const raw = (await this.redis.eval(
      MUTATE,
      3,
      k.cards,
      k.seq,
      k.log,
      k.events,
      m.kind,
      m.id,
      m.column ?? "",
      m.title ?? "",
      String(m.baseVersion ?? 0),
      by,
      String(Date.now()),
      m.kind === "create" ? "created" : m.kind === "move" ? "moved" : "renamed",
    )) as string;
    const out = JSON.parse(raw) as { ok?: true; event?: BoardEvent; err?: RejectReason; card?: Card };
    if (out.ok && out.event) return { ok: true, event: out.event };
    return { ok: false, reason: out.err ?? "missing", ...(out.card ? { card: out.card } : {}) };
  }

  async snapshot(board: string): Promise<{ seq: number; cards: Card[] }> {
    const k = this.keys(board);
    const [seq, flat] = (await this.redis.eval(SNAPSHOT, 2, k.cards, k.seq)) as [string, string[]];
    return { seq: Number(seq), cards: flat.map((c) => JSON.parse(c) as Card) };
  }

  async currentSeq(board: string): Promise<number> {
    return Number((await this.redis.get(this.keys(board).seq)) ?? 0);
  }

  // Events with a sequence number above `after`, oldest first. The log is a
  // list, so event N sits at index N - 1.
  async eventsAfter(board: string, after: number, limit = PAGE): Promise<BoardEvent[]> {
    const rows = await this.redis.lrange(this.keys(board).log, after, after + limit - 1);
    return rows.map((r) => JSON.parse(r) as BoardEvent);
  }
}
