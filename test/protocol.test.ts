import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/shared/protocol.ts";

const j = (o: unknown) => JSON.stringify(o);
const hello = { type: "hello", board: "main", user: { id: "ana", name: "Ana" }, lastSeq: null };

describe("parseClientMessage: hello", () => {
  it("accepts a first visit with no sequence number", () => {
    expect(parseClientMessage(j(hello))).toEqual({ ok: true, message: hello });
  });

  it("accepts a return visit with a sequence number", () => {
    const r = parseClientMessage(j({ ...hello, lastSeq: 42 }));
    expect(r.ok && r.message.type === "hello" && r.message.lastSeq).toBe(42);
  });

  it("trims the user name", () => {
    const r = parseClientMessage(j({ ...hello, user: { id: "ana", name: "  Ana  " } }));
    expect(r.ok && r.message.type === "hello" && r.message.user.name).toBe("Ana");
  });

  it("refuses each malformed field", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["a board id with a slash", { board: "a/b" }],
      ["an empty board id", { board: "" }],
      ["a missing user", { user: undefined }],
      ["a user id with spaces", { user: { id: "a b", name: "Ana" } }],
      ["a blank user name", { user: { id: "ana", name: "  " } }],
      ["a 41 character name", { user: { id: "ana", name: "x".repeat(41) } }],
      ["a negative lastSeq", { lastSeq: -1 }],
      ["a fractional lastSeq", { lastSeq: 1.5 }],
      ["a string lastSeq", { lastSeq: "3" }],
    ];
    for (const [label, patch] of bad) {
      expect(parseClientMessage(j({ ...hello, ...patch })).ok, label).toBe(false);
    }
  });
});

describe("parseClientMessage: card messages", () => {
  const create = { type: "create", reqId: "r1", id: "c1", title: "Write tests", column: "todo" };
  const move = { type: "move", reqId: "r2", id: "c1", column: "doing", baseVersion: 1 };
  const rename = { type: "rename", reqId: "r3", id: "c1", title: "New name", baseVersion: 2 };

  it("accepts create, move and rename", () => {
    expect(parseClientMessage(j(create)).ok).toBe(true);
    expect(parseClientMessage(j(move)).ok).toBe(true);
    expect(parseClientMessage(j(rename)).ok).toBe(true);
  });

  it("trims a title", () => {
    const r = parseClientMessage(j({ ...create, title: "  padded  " }));
    expect(r.ok && r.message.type === "create" && r.message.title).toBe("padded");
  });

  it("refuses a title over 120 characters", () => {
    expect(parseClientMessage(j({ ...create, title: "x".repeat(121) })).ok).toBe(false);
  });

  it("refuses an empty title on create and on rename", () => {
    expect(parseClientMessage(j({ ...create, title: " " })).ok).toBe(false);
    expect(parseClientMessage(j({ ...rename, title: "" })).ok).toBe(false);
  });

  it("refuses a column that is not on the board", () => {
    expect(parseClientMessage(j({ ...move, column: "blocked" })).ok).toBe(false);
    expect(parseClientMessage(j({ ...create, column: "Todo" })).ok).toBe(false);
  });

  it("refuses a move with no base version, with zero, or with a fraction", () => {
    expect(parseClientMessage(j({ ...move, baseVersion: undefined })).ok).toBe(false);
    expect(parseClientMessage(j({ ...move, baseVersion: 0 })).ok).toBe(false);
    expect(parseClientMessage(j({ ...move, baseVersion: 1.5 })).ok).toBe(false);
  });

  it("refuses ids with characters outside letters, digits, dash and underscore", () => {
    expect(parseClientMessage(j({ ...move, id: "a:b" })).ok).toBe(false);
    expect(parseClientMessage(j({ ...move, reqId: "x".repeat(65) })).ok).toBe(false);
  });
});

describe("parseClientMessage: junk", () => {
  it("refuses text that is not json", () => {
    expect(parseClientMessage("{nope")).toEqual({ ok: false, error: "not json" });
  });

  it("refuses json that is not an object", () => {
    for (const raw of ["null", "[]", "3", '"hello"']) {
      expect(parseClientMessage(raw), raw).toEqual({ ok: false, error: "not an object" });
    }
  });

  it("refuses an unknown type", () => {
    expect(parseClientMessage(j({ type: "delete", id: "c1" }))).toEqual({ ok: false, error: "unknown type" });
  });
});
