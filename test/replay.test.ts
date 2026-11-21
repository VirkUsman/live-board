import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rig, sleep, user } from "./helpers.ts";

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});
afterEach(() => rig.cleanup());

describe("sequence numbers", () => {
  it("sends a snapshot at sequence 0 to the first visitor of a new board", async () => {
    const s = await rig.server();
    const c = await rig.client(s);
    c.hello("main", user("Ana"));
    await c.until((x) => x.of("snapshot").length === 1);
    expect(c.of("snapshot")[0]).toEqual({ type: "snapshot", seq: 0, cards: [] });
  });

  it("acknowledges a create with the sequence number it got", async () => {
    const s = await rig.server();
    const c = await rig.client(s);
    c.hello("main", user("Ana"));
    await c.until((x) => x.of("snapshot").length === 1);
    c.create("c1", "First");
    await c.until((x) => x.of("ack").length === 1);
    expect(c.of("ack")[0]).toMatchObject({ reqId: "qc1", seq: 1 });
  });

  it("gives every event the next number, and every client sees the same run", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    const b = await rig.client(s);
    a.hello("main", user("Ana"));
    b.hello("main", user("Bo"));
    await a.until((x) => x.of("snapshot").length === 1);
    await b.until((x) => x.of("snapshot").length === 1);
    for (let i = 0; i < 6; i++) (i % 2 ? a : b).create(`c${i}`, `Card ${i}`);
    await a.until((x) => x.events().length === 6);
    await b.until((x) => x.events().length === 6);
    expect(a.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(b.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.events().map((e) => e.card.id)).toEqual(b.events().map((e) => e.card.id));
  });

  it("starts a late joiner from a snapshot and then continues with the next number", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    a.hello("main", user("Ana"));
    await a.until((x) => x.of("snapshot").length === 1);
    for (let i = 0; i < 3; i++) a.create(`c${i}`, `Card ${i}`);
    await a.until((x) => x.events().length === 3);

    const b = await rig.client(s);
    b.hello("main", user("Bo"));
    await b.until((x) => x.of("snapshot").length === 1);
    expect(b.of("snapshot")[0]?.seq).toBe(3);
    expect(b.of("snapshot")[0]?.cards).toHaveLength(3);
    expect(b.events()).toEqual([]);
    a.create("c3", "Card 3");
    await b.until((x) => x.events().length === 1);
    expect(b.seqs()).toEqual([4]);
  });

  it("keeps the numbers of two boards separate", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    const b = await rig.client(s);
    a.hello("one", user("Ana"));
    b.hello("two", user("Bo"));
    await a.until((x) => x.of("snapshot").length === 1);
    await b.until((x) => x.of("snapshot").length === 1);
    a.create("c1", "On one");
    await a.until((x) => x.events().length === 1);
    await sleep(100);
    expect(b.events()).toEqual([]);
    b.create("c1", "On two");
    await b.until((x) => x.events().length === 1);
    expect(b.seqs()).toEqual([1]);
  });
});

describe("reconnect", () => {
  it("gets exactly the events it missed, in order, and no snapshot", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    const b = await rig.client(s);
    a.hello("main", user("Ana"));
    b.hello("main", user("Bo"));
    await a.until((x) => x.of("snapshot").length === 1);
    for (let i = 0; i < 3; i++) b.create(`c${i}`, `Card ${i}`);
    await a.until((x) => x.events().length === 3);
    a.close();
    await a.until((x) => x.closeCode !== undefined);

    for (let i = 3; i < 8; i++) b.create(`c${i}`, `Card ${i}`);
    await b.until((x) => x.events().length === 8);

    const a2 = await rig.client(s);
    a2.hello("main", user("Ana"), 3);
    await a2.until((x) => x.events().length === 5);
    expect(a2.seqs()).toEqual([4, 5, 6, 7, 8]);
    expect(a2.of("snapshot")).toEqual([]);
  });

  it("gets nothing when it missed nothing, then each new event once", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    a.hello("main", user("Ana"));
    await a.until((x) => x.of("snapshot").length === 1);
    a.create("c1", "One");
    await a.until((x) => x.events().length === 1);
    a.close();

    const a2 = await rig.client(s);
    a2.hello("main", user("Ana"), 1);
    await sleep(150);
    expect(a2.events()).toEqual([]);
    a2.create("c2", "Two");
    await a2.until((x) => x.events().length === 1);
    await sleep(100);
    expect(a2.seqs()).toEqual([2]);
  });

  it("falls back to a snapshot when the client is ahead of the server", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    a.hello("main", user("Ana"), 999);
    await a.until((x) => x.of("snapshot").length === 1);
    expect(a.of("snapshot")[0]?.seq).toBe(0);
  });

  it("delivers a 450 event backlog in order across several batches", async () => {
    const s = await rig.server();
    const w = await rig.client(s);
    w.hello("main", user("Writer"));
    await w.until((x) => x.of("snapshot").length === 1);
    for (let i = 0; i < 450; i++) w.create(`c${i}`, `Card ${i}`);
    await w.until((x) => x.events().length === 450, 15000);

    const r = await rig.client(s);
    r.hello("main", user("Reader"), 0);
    await r.until((x) => x.events().length === 450, 15000);
    expect(r.seqs()).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
  });

  it("loses and repeats nothing when a reader reconnects over and over during writes", async () => {
    const s = await rig.server();
    const w = await rig.client(s);
    w.hello("main", user("Writer"));
    await w.until((x) => x.of("snapshot").length === 1);

    const TOTAL = 200;
    let last = 0;
    let dupes = 0;
    let gaps = 0;
    const take = (seqs: number[]) => {
      for (const q of seqs) {
        if (q <= last) dupes++;
        else if (q !== last + 1) gaps++;
        else last = q;
      }
    };

    let sent = 0;
    const writing = (async () => {
      while (sent < TOTAL) {
        w.create(`c${sent}`, `Card ${sent}`);
        sent++;
        if (sent % 5 === 0) await sleep(2);
      }
    })();

    while (last < TOTAL) {
      const r = await rig.client(s);
      r.hello("main", user("Reader"), last);
      await sleep(30);
      take(r.seqs());
      r.kill();
    }
    await writing;
    expect(dupes).toBe(0);
    expect(gaps).toBe(0);
    expect(last).toBe(TOTAL);
  }, 30000);
});
