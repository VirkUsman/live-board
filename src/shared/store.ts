import type { BoardEvent, Card, User } from "./protocol.ts";

export interface Pending {
  id: string;
  before: Card | undefined;
}

export interface BoardState {
  cards: Record<string, Card>;
  seq: number;
  synced: boolean;
  pending: Record<string, Pending>;
  presence: User[];
}

export const emptyState: BoardState = { cards: {}, seq: 0, synced: false, pending: {}, presence: [] };

export function applySnapshot(_state: BoardState, seq: number, cards: Card[]): BoardState {
  const map: Record<string, Card> = {};
  for (const c of cards) map[c.id] = c;
  return { cards: map, seq, synced: true, pending: {}, presence: _state.presence };
}

export type EventResult = { state: BoardState; outcome: "applied" | "duplicate" | "gap" };

// Events must arrive in order. A repeat is dropped, a hole means the client
// has to reconnect and ask for what it missed.
export function applyEvent(state: BoardState, event: BoardEvent): EventResult {
  if (event.seq <= state.seq) return { state, outcome: "duplicate" };
  if (event.seq !== state.seq + 1) return { state, outcome: "gap" };
  return {
    state: { ...state, seq: event.seq, cards: { ...state.cards, [event.card.id]: event.card } },
    outcome: "applied",
  };
}

export function optimistic(state: BoardState, reqId: string, next: Card): BoardState {
  return {
    ...state,
    cards: { ...state.cards, [next.id]: next },
    pending: { ...state.pending, [reqId]: { id: next.id, before: state.cards[next.id] } },
  };
}

function withoutPending(state: BoardState, reqId: string): Record<string, Pending> {
  const { [reqId]: _gone, ...rest } = state.pending;
  return rest;
}

export function acknowledge(state: BoardState, reqId: string): BoardState {
  return { ...state, pending: withoutPending(state, reqId) };
}

// The server said no. Show the server's card if it sent one and it is not
// older than what is on screen, otherwise put back what was there before.
export function reject(state: BoardState, reqId: string, serverCard?: Card): BoardState {
  const p = state.pending[reqId];
  const pending = withoutPending(state, reqId);
  if (!p) return { ...state, pending };
  const current = state.cards[p.id];
  const cards = { ...state.cards };
  if (serverCard && (!current || serverCard.version >= current.version)) {
    cards[p.id] = serverCard;
  } else if (p.before) {
    cards[p.id] = p.before;
  } else {
    delete cards[p.id];
  }
  return { ...state, cards, pending };
}

export function isPending(state: BoardState, cardId: string): boolean {
  return Object.values(state.pending).some((p) => p.id === cardId);
}

export function cardsIn(state: BoardState, column: string): Card[] {
  return Object.values(state.cards)
    .filter((c) => c.column === column)
    .sort((a, b) => a.n - b.n || a.id.localeCompare(b.id));
}
