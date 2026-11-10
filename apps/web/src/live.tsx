import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LiveEvent } from './api';

type Announce = (message: string) => void;
const AnnounceContext = createContext<Announce>(() => {});
export const useAnnounce = () => useContext(AnnounceContext);

/**
 * A polite live region that batches. Seat changes can arrive many times a second, and reading each
 * one aloud would make a screen reader unusable, so they collapse to "3 seats changed".
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState('');
  const queue = useRef<string[]>([]);
  const timer = useRef<number | null>(null);

  const announce: Announce = (message) => {
    queue.current.push(message);
    timer.current ??= window.setTimeout(() => {
      const items = queue.current;
      queue.current = [];
      timer.current = null;
      setText(items.length === 1 ? items[0]! : `${items.length} seats changed`);
    }, 1500);
  };

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div aria-live="polite" role="status" className="sr-only">
        {text}
      </div>
    </AnnounceContext.Provider>
  );
}

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/**
 * One EventSource per page, carrying the board and team channels together: browsers allow only
 * about six HTTP/1.1 connections per origin. EventSource reconnects and sends Last-Event-ID itself;
 * every reconnect or `resync` also refetches snapshots, because a delta can only make a client
 * briefly stale while a snapshot makes it right.
 */
export function useLiveEvents(channel: { hackathon?: string | null; team?: string | null }, onEvent: (e: LiveEvent) => void): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  const [attempt, setAttempt] = useState(0);
  const dropped = useRef(false);
  const failures = useRef(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const params = new URLSearchParams();
    if (channel.hackathon) params.set('hackathon', channel.hackathon);
    if (channel.team) params.set('team', channel.team);
    if (![...params].length) return;

    const source = new EventSource(`/api/events?${params}`);
    let retryTimer: number | undefined;

    source.addEventListener('ready', () => {
      setState('live');
      if (dropped.current) void client.invalidateQueries();
      // The snapshot was fetched before this stream subscribed, so anything in between is caught here.
      else {
        if (channel.hackathon) void client.invalidateQueries({ queryKey: ['board', channel.hackathon] });
        if (channel.team) void client.invalidateQueries({ queryKey: ['team', channel.team] });
      }
      dropped.current = false;
      failures.current = 0;
    });
    source.addEventListener('change', (e) => handler.current(JSON.parse((e as MessageEvent<string>).data) as LiveEvent));
    source.addEventListener('resync', () => void client.invalidateQueries());
    source.onerror = () => {
      dropped.current = true;
      setState('reconnecting');
      if (source.readyState !== EventSource.CLOSED) return; // the browser is retrying by itself
      // Any answer but a stream (a 401, a 502 mid-deploy) closes it for good, so reopen it ourselves.
      source.close();
      const n = failures.current++;
      // After a sign-out elsewhere /me answers 401, useMe turns that into null and the guard sends the user to sign in.
      void client.invalidateQueries({ queryKey: ['me'] });
      const delay = Math.min(30_000, 1000 * 2 ** n) * (0.5 + Math.random() / 2);
      retryTimer = window.setTimeout(() => setAttempt((a) => a + 1), delay);
    };
    return () => {
      window.clearTimeout(retryTimer);
      source.close();
    };
  }, [channel.hackathon, channel.team, client, attempt]);

  return state;
}
