import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rig, sleep, user, type TestClient } from "./helpers.ts";

let rig: Rig;
beforeEach(() => {
  rig = new Rig();
});
afterEach(() => rig.cleanup());

async function join(c: TestClient, name: string, board = "main") {
  c.hello(board, user(name));
  await c.until((x) => x.of("snapshot").length === 1);
}

describe("presence", () => {
  it("lists the person who just joined", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    await join(a, "Ana");
    await a.until((x) => x.lastPresence() !== undefined);
    expect(a.lastPresence()).toEqual(["Ana"]);
  });

  it("shows a second person to the first, sorted by name", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    const b = await rig.client(s);
    await join(b, "Bo");
    await join(a, "Ana");
    await a.until((x) => x.lastPresence()?.length === 2);
    await b.until((x) => x.lastPresence()?.length === 2);
    expect(b.lastPresence()).toEqual(["Ana", "Bo"]);
  });

  it("removes someone who closes the socket", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    const b = await rig.client(s);
    await join(a, "Ana");
    await join(b, "Bo");
    await a.until((x) => x.lastPresence()?.length === 2);
    b.close();
    await a.until((x) => x.lastPresence()?.length === 1);
    expect(a.lastPresence()).toEqual(["Ana"]);
  });

  it("counts one user once across two sockets, and keeps them until both are gone", async () => {
    const s = await rig.server();
    const watcher = await rig.client(s);
    const t1 = await rig.client(s);
    const t2 = await rig.client(s);
    await join(watcher, "Wes");
    await join(t1, "Tia");
    await join(t2, "Tia");
    await watcher.until((x) => x.lastPresence()?.includes("Tia"));
    await sleep(100);
    expect(watcher.lastPresence()).toEqual(["Tia", "Wes"]);
    t1.close();
    await sleep(150);
    expect(watcher.lastPresence()).toEqual(["Tia", "Wes"]);
    t2.close();
    await watcher.until((x) => x.lastPresence()?.length === 1);
    expect(watcher.lastPresence()).toEqual(["Wes"]);
  });

  it("keeps boards apart", async () => {
    const s = await rig.server();
    const a = await rig.client(s);
    const b = await rig.client(s);
    await join(a, "Ana", "one");
    await join(b, "Bo", "two");
    await sleep(150);
    expect(a.lastPresence()).toEqual(["Ana"]);
    expect(b.lastPresence()).toEqual(["Bo"]);
  });
});

describe("a socket that dies without a close frame", () => {
  it("is dropped by the heartbeat when it stops answering pings", async () => {
    const s = await rig.server({ heartbeatMs: 100 });
    const watcher = await rig.client(s);
    const mute = await rig.client(s, { autoPong: false });
    await join(watcher, "Wes");
    await join(mute, "Mute");
    await watcher.until((x) => x.lastPresence()?.length === 2);
    const t0 = Date.now();
    await watcher.until((x) => x.lastPresence()?.length === 1, 3000);
    expect(watcher.lastPresence()).toEqual(["Wes"]);
    // two missed beats, not more than a handful of them
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(s.connectionCount()).toBe(1);
  });

  it("is dropped when the transport is destroyed under it", async () => {
    const s = await rig.server({ heartbeatMs: 100 });
    const watcher = await rig.client(s);
    const gone = await rig.client(s);
    await join(watcher, "Wes");
    await join(gone, "Gone");
    await watcher.until((x) => x.lastPresence()?.length === 2);
    (gone.ws as unknown as { _socket: { destroy: () => void } })._socket.destroy();
    await watcher.until((x) => x.lastPresence()?.length === 1, 3000);
    expect(watcher.lastPresence()).toEqual(["Wes"]);
  });

  it("does not drop a client that keeps answering", async () => {
    const s = await rig.server({ heartbeatMs: 100 });
    const a = await rig.client(s);
    await join(a, "Ana");
    await sleep(900);
    expect(s.connectionCount()).toBe(1);
    expect(a.closeCode).toBeUndefined();
    const b = await rig.client(s);
    await join(b, "Bo");
    await b.until((x) => x.lastPresence()?.length === 2);
    expect(b.lastPresence()).toEqual(["Ana", "Bo"]);
  });

  it("ignores an entry left behind by a crashed instance once it is stale", async () => {
    const s = await rig.server({ heartbeatMs: 100 });
    const redis = rig.redis();
    const ghost = JSON.stringify({ k: "dead:1", user: { id: "ghost", name: "Ghost" } });
    await redis.zadd(`${rig.prefix}:main:presence`, Date.now() - 5000, ghost);
    const a = await rig.client(s);
    await join(a, "Ana");
    await a.until((x) => x.lastPresence() !== undefined);
    expect(a.lastPresence()).toEqual(["Ana"]);
    expect(await redis.zscore(`${rig.prefix}:main:presence`, ghost)).toBeNull();
  });
});
