import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { User } from "../shared/protocol.ts";
import { BoardClient, type ClientView } from "./client.ts";

export interface UseBoardOptions {
  url: string;
  board: string;
  user: User;
  WebSocketImpl?: new (url: string) => WebSocket;
  reconnectBaseMs?: number;
}

export function useBoard(opts: UseBoardOptions): { client: BoardClient; view: ClientView } {
  const { url, board, user, WebSocketImpl, reconnectBaseMs } = opts;
  const client = useMemo(
    () =>
      new BoardClient({
        url,
        board,
        user,
        ...(WebSocketImpl ? { WebSocketImpl } : {}),
        ...(reconnectBaseMs !== undefined ? { reconnectBaseMs } : {}),
      }),
    [url, board, user, WebSocketImpl, reconnectBaseMs],
  );
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  const view = useSyncExternalStore(client.subscribe, client.getView);
  return { client, view };
}
