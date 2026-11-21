# live-board

_Built with AI assistance._

A shared task board that several people can have open at once. A Node server
speaks WebSocket (`ws`), keeps the board in Redis, and a React client built
with Vite shows three columns, who else is on the board, and moves cards with
optimistic updates that correct themselves when the server disagrees.

It is small on purpose. There is no login, no drag and drop, and cards move
between columns with a pair of buttons. The work went into the four things
that usually break first in a realtime app: ordering, catching up after a drop,
two people editing one thing, and knowing who is really there.

TypeScript in strict mode, Node 24, React 18, Vite 8, `ws`, ioredis. 129 tests
in 12 files, about 8 seconds against a local Redis.

## How an event travels

Every change goes through one Lua script in Redis (`src/server/board.ts`). In a
single step it checks the card's version, writes the card, takes the next
number from a counter, appends the event to a list, and publishes the number
on a channel. Because it is one step, the numbers have no gaps and the log
order is the publish order, even with two server instances writing together.

Each socket on a server has a pointer, the last number it was sent. Whenever
the channel fires, or the socket first says hello, the server reads the log
from that pointer to the end and sends what it finds, one batch at a time. A
live event and a replay are the same code path, so they cannot overlap and
cannot skip. A client that comes back sends `lastSeq` in its hello and gets
exactly the events after it. A client with no `lastSeq`, or one ahead of the
server, gets a snapshot (the cards and the number they stand at) and carries on
from there.

The client applies events only in order (`src/shared/store.ts`). An event it
has already seen is dropped. A number that skips ahead makes it close the
socket and reconnect, which asks for the hole to be filled.

```
src/shared/protocol.ts   message types and the parser for what clients send
src/shared/store.ts      the client's state as plain functions
src/server/board.ts      the Redis script, snapshot and log reads
src/server/server.ts     sockets, replay pump, presence, heartbeat
src/web/connection.ts    reconnecting socket with backoff
src/web/client.ts        board state machine, no React in it
src/web/Board.tsx        the screen
```

## Moving the same card twice

A move carries the version the mover saw. The script refuses it unless that is
still the card's version, and a refusal carries the card as it now stands. The
client has already shown the move, marked the card pending and disabled its
buttons; on a refusal it puts the server's card in its place and shows a short
alert ("Someone else changed ... first. Showing their version."). A refusal
that carries an older card than the one on screen is ignored, so a late message
cannot undo a newer one.

Two tests cover this at different heights. In `conflicts.test.ts`, two raw
sockets send a move from the same version in the same tick, on one server and
on two: exactly one is acknowledged, one refused, both end on one column. In
`e2e.test.tsx`, two rendered boards click the same button together with
`fireEvent`, which is synchronous, and exactly one of them shows the alert.

## Presence that survives a pulled cable

Presence lives in a Redis sorted set scored by time, so every instance sees the
same list. A server pings each socket on an interval. A socket that has not
answered the previous ping is terminated, which fires the usual close handling
and removes it. Live sockets refresh their score on each beat, and entries
older than three beats are ignored and pruned, so a crashed instance does not
leave ghosts. One person on two tabs appears once.

The test for this uses a client built with `autoPong: false`, which never
answers a ping and never sends a close frame. With a 100 ms beat it is gone
from the other client's list in under 1.5 seconds (the test asserts that bound).

## Running it

You need Node 22 or newer and Redis.

    npm ci
    export REDIS_URL=redis://127.0.0.1:6379
    npm test
    npm run serve        # ws server on :8787
    npm run dev          # Vite on :5173, proxies /ws to the server

Open `http://localhost:5173/?name=Ana&board=main` in two windows. Run
`INSTANCE_ID=b PORT=8788 npm run serve` as well to have two servers on one
Redis. Tests need Redis and stop with one line if it is not there. Each test
file writes under its own key prefix and deletes it afterwards.

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | shared state and fan out |
| `PORT` | 8787 | server port |
| `INSTANCE_ID` | random | shown in `/health` and used in presence keys |

## What the 129 tests cover

| Area | Tests | What is checked |
|---|---|---|
| Parser | 17 | every field of every client message, junk input |
| Redis script | 17 | versions, numbers, 20 racing moves, 50 racing creates, snapshot, publish |
| Replay | 10 | missed events only, 450 event backlog, 200 events while a reader reconnects repeatedly: 0 repeats, 0 gaps |
| Instances | 5 | two servers, same 1 to 20 run for both clients, replay on the other server |
| Conflicts | 8 | winner, loser's card, retry, stale rename, missing card, duplicate create |
| Presence | 9 | join, leave, one user two sockets, mute socket, destroyed transport, stale entry |
| Edges | 9 | bad JSON, no hello, double hello, 20 KB frame closes with 1009, `/health` |
| Client store | 16 | order, repeats, holes, optimism, rejection |
| Connection and client | 27 | hello with `lastSeq`, backoff 100, 200, 400, 800 ms to a cap, rollback on drop |
| Screen | 12 | columns, counts, disabled buttons, alert, presence list |
| End to end | 4 | two boards on a real server, simultaneous move, drop and catch up |

## One bug, and two harness snags

**A late rejection undid a newer card.** The first version of `reject` fell
back to "put back what was there before" whenever the server's card was older
than the one on screen. The store test for exactly that case failed: a card
that had moved to Done at version 3 went back to To do at version 1. A
rejection now changes nothing when it carries an older card, and without a
card it only undoes the optimistic change if nothing newer has landed.

Two test problems, neither in the product. The simultaneous move tests first
waited for two replies on the client that never made the create, so they timed
out. And the end to end file first used the global WebSocket, which inside
jsdom is Node's own and rejects jsdom's Event objects; the boards there now
use the `ws` client, which has the same handler properties.

## Where it falls short

- The event log is never trimmed, so replay can always find a client's place.
  A long lived board needs a cut off and a snapshot fallback for old clients.
- Cards move between columns, not within one. Order is creation order.
- Anyone can join any board by name. There is no auth and no per socket rate
  limit, only a 16 KB frame cap.
- Presence is eventually consistent. After an instance dies its people stay
  listed until their entries are three beats old.
- If Redis goes down the servers do not reconnect their pub/sub gracefully; I
  did not test that.
- Drag and drop, accessibility beyond labelled buttons, and mobile layout were
  not tested in a real browser. The tests run in jsdom, which has no layout, so
  button widths and the reserved notice area are not measured.
- The CI workflow uses Redis 7 on Linux and has not run yet.

MIT licence.
