import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rig, sleep, user } from "./helpers.ts";

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});
afterEach(() => rig.cleanup());

describe("what the server does with bad input", () => {
  it("answers text that is not json with an error and stays open", async () => {
    const s = await rig.server();
    const c = await rig.client(s);
    c.ws.send("{broken");
    await c.until((x) => x.of("error").length === 1);
    expect(c.of("error")[0]?.message).toBe("not json");
    expect(c.closeCode).toBeUndefined();
  });

  it("answers a message with a bad field and names the field", async () => {
    const s = await rig.server();
    const c = await rig.client(s);
    c.send({ type: "hello", board: "bad board", user: user("Ana"), lastSeq: null });
    await c.until((x) => x.of("error").length === 1);
    expect(c.of("error")[0]?.message).toBe("bad board id");
  });

  it("refuses to change a card before hello", async () => {
    const s = await rig.server();
    const c = await rig.client(s);
    c.create("c1", "Early");
    await c.until((x) => x.of("error").length === 1);
    expect(c.of("error")[0]?.message).toBe("say hello first");
  });

  it("refuses a second hello", async () => {
    const s = await rig.server();
    const c = await rig.client(s);
    c.hello("main", user("Ana"));
    await c.until((x) => x.of("snapshot").length === 1);
    c.hello("other", user("Ana"));
    await c.until((x) => x.of("error").length === 1);
    expect(c.of("error")[0]?.message).toBe("already joined");
  });

  it("closes a connection that sends more than 16 KB in one frame", async () => {
    const s = await rig.server();
    const c = await rig.client(s);
    c.ws.send("x".repeat(20 * 1024));
    await c.until((x) => x.closeCode !== undefined);
    expect(c.closeCode).toBe(1009);
  });

  it("does not let a bad client stop a good one", async () => {
    const s = await rig.server();
    const bad = await rig.client(s);
    const good = await rig.client(s);
    good.hello("main", user("Ana"));
    await good.until((x) => x.of("snapshot").length === 1);
    bad.ws.send("{broken");
    good.create("c1", "Still works");
    await good.until((x) => x.events().length === 1);
    expect(good.seqs()).toEqual([1]);
  });
});

describe("the process around it", () => {
  it("answers /health with its instance id and connection count", async () => {
    const s = await rig.server({ instanceId: "alpha" });
    const c = await rig.client(s);
    c.hello("main", user("Ana"));
    await c.until((x) => x.of("snapshot").length === 1);
    const res = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(await res.json()).toEqual({ ok: true, instance: "alpha", connections: 1 });
  });

  it("answers any other path with 404", async () => {
    const s = await rig.server();
    expect((await fetch(`http://127.0.0.1:${s.port}/nope`)).status).toBe(404);
  });

  it("disconnects every client when it closes", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    const b = await rig.client(s);
    a.hello("main", user("Ana"));
    b.hello("main", user("Bo"));
    await a.until((x) => x.of("snapshot").length === 1);
    await b.until((x) => x.of("snapshot").length === 1);
    await s.close();
    await a.until((x) => x.closeCode !== undefined);
    await b.until((x) => x.closeCode !== undefined);
    expect(s.connectionCount()).toBe(0);
    await sleep(10);
  });
});
