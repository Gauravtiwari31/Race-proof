import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ArenaResult, type ArenaRun } from '../api';
import { Button, Card, useToast } from '../components/ui';

type Mode = 'safe' | 'naive';

/** Real latencies, slowed down so the race can be watched. Reduced motion jumps to the result. */
const REPLAY_MS = 2200;

function Histogram({ results }: { results: ArenaResult[] }) {
  const buckets = useMemo(() => {
    const times = results.map((r) => r.ms);
    const max = Math.max(...times, 1);
    const size = max / 12;
    const counts = Array.from({ length: 12 }, (_, i) => ({ from: i * size, to: (i + 1) * size, n: 0 }));
    for (const t of times) counts[Math.min(11, Math.floor(t / size))]!.n++;
    return counts;
  }, [results]);
  const peak = Math.max(...buckets.map((b) => b.n), 1);

  return (
    <figure>
      <figcaption className="eyebrow">Response time per bot</figcaption>
      <div className="mt-2 flex h-28 items-end gap-0.5 border-b border-line-soft" role="img" aria-label={`Response times from ${buckets[0]!.from.toFixed(0)} to ${buckets[11]!.to.toFixed(0)} milliseconds`}>
        {buckets.map((b) => (
          <div key={b.from} title={`${b.from.toFixed(0)} to ${b.to.toFixed(0)} ms: ${b.n} bots`} className="group flex h-full flex-1 items-end">
            <div className="w-full rounded-t-sm bg-accent/80 group-hover:bg-accent-hi" style={{ height: b.n ? `${Math.max(4, (b.n / peak) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs text-ink-mute">
        <span>0 ms</span>
        <span>{buckets[11]!.to.toFixed(0)} ms</span>
      </div>
    </figure>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-line-soft bg-bg p-3">
      <dt className="eyebrow">{label}</dt>
      <dd className={`display mt-1.5 text-3xl ${tone === 'good' ? 'text-accent' : tone === 'bad' ? 'text-danger' : ''}`}>{value}</dd>
    </div>
  );
}

export function Arena() {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('safe');
  const [run, setRun] = useState<ArenaRun | null>(null);
  const [revealed, setRevealed] = useState(0);
  const frame = useRef<number | null>(null);

  // Bots are revealed in the order the database actually answered them.
  const ordered = useMemo(() => (run ? [...run.results].sort((a, b) => a.ms - b.ms) : []), [run]);

  useEffect(() => {
    if (!run) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRevealed(run.results.length);
      return;
    }
    const start = performance.now();
    const maxMs = Math.max(...run.results.map((r) => r.ms), 1);
    const tick = (now: number) => {
      const replayedMs = ((now - start) / REPLAY_MS) * maxMs;
      const count = run.results.filter((r) => r.ms <= replayedMs).length;
      setRevealed(count);
      if (count < run.results.length) frame.current = requestAnimationFrame(tick);
    };
    setRevealed(0);
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [run]);

  const start = useMutation({
    mutationFn: () => api<ArenaRun>('/arena/run', { method: 'POST', body: { mode, bots: 50 } }),
    onSuccess: setRun,
    onError: (err) => toast(err.message, 'error'),
  });

  const shown = new Map(ordered.slice(0, revealed).map((r) => [r.name, r]));
  const done = run !== null && revealed >= run.results.length;
  const winnersSoFar = [...shown.values()].filter((r) => r.outcome === 'won');
  const seatTotal = run?.seats ?? 4;
  const seatedBefore = run?.seatedBefore ?? 3;
  const filled = seatedBefore + winnersSoFar.length;
  const bots = run?.results.map((r) => r.name) ?? Array.from({ length: 50 }, (_, i) => `Bot ${i + 4}`);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <p className="eyebrow">Live demo · real transactions</p>
        <h1 className="display mt-2 text-5xl sm:text-6xl">Race Arena</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Fifty bots fight for one seat in a throwaway team. These are real transactions against the real database. Switch to the naive code to see what most implementations do.
        </p>
      </div>

      <Card>
        <fieldset>
          <legend className="eyebrow">Seat logic</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[
              { value: 'safe' as const, title: 'Conditional UPDATE', sql: 'UPDATE ... WHERE member_count < max_size' },
              { value: 'naive' as const, title: 'Naive read, then write', sql: 'SELECT count, then UPDATE count + 1' },
            ].map((option) => (
              <label key={option.value} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${mode === option.value ? (option.value === 'naive' ? 'border-danger bg-danger/5' : 'border-accent bg-accent/5') : 'border-line-soft hover:border-line'}`}>
                <input type="radio" name="mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} className="mt-1 [accent-color:var(--color-accent)]" />
                <span className="min-w-0">
                  <span className="display block text-lg">{option.title}</span>
                  <code className="block font-mono text-xs break-words text-ink-mute">{option.sql}</code>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button tone="primary" className="mt-3 w-full sm:w-auto" busy={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? 'Racing' : run ? 'Run it again' : 'Unleash 50 bots'}
        </Button>
      </Card>

      <Card>
        <h2 className="eyebrow">The team: {Math.min(filled, seatTotal)} of {seatTotal} seats{filled > seatTotal ? `, plus ${filled - seatTotal} too many` : ''}</h2>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-3 px-1.5" aria-hidden="true">
          {Array.from({ length: Math.max(seatTotal, filled) }, (_, i) => {
            const taken = i < filled;
            const over = i >= seatTotal;
            return (
              <li key={i} className={`seat h-11 w-10 text-xs ${!taken ? 'seat-empty' : over ? 'seat-in bg-danger text-bg' : i >= seatedBefore ? 'seat-in bot-won bg-accent text-on-accent' : 'bg-ink-soft text-bg'}`}>{!taken ? 'ABCDEFGHJK'[i] : ''}</li>
            );
          })}
        </ul>

        <h2 className="eyebrow mt-6">The bots</h2>
        <ul className="mt-2 grid max-w-md grid-cols-10 gap-1 sm:gap-1.5" aria-hidden="true">
          {bots.map((name) => {
            const result = shown.get(name);
            return (
              <li
                key={name}
                title={result ? `${name}: ${result.outcome === 'won' ? 'took a seat' : result.code} in ${result.ms} ms` : name}
                className={`aspect-square rounded-sm ${
                  !result
                    ? start.isPending ? 'animate-pulse bg-line' : 'bg-line-soft'
                    : result.outcome === 'won'
                      ? (run?.winners ?? 0) > 1 ? 'bg-danger' : 'bot-won bg-accent'
                      : 'bot-lost border border-danger/60 bg-danger/10'
                }`}
              />
            );
          })}
        </ul>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-mute" aria-label="Legend">
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm bg-accent" />Took the seat</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm border border-danger/60 bg-danger/10" />Refused, 409 TEAM_FULL</li>
          <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm bg-line-soft" />Still waiting</li>
        </ul>
      </Card>

      {run && done && (
        <Card>
          <p role="status" className={`rise font-display text-2xl leading-tight font-semibold sm:text-3xl ${run.invariantHolds ? 'text-accent' : 'text-danger'}`}>
            {run.invariantHolds
              ? `One winner. ${run.results.length - 1} refused with TEAM_FULL. The team count matches its members.`
              : `Broken: ${run.winners} bots took one seat. The team thinks it has ${run.memberCount} members and really has ${run.actualMembers}.`}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Winners" value={run.winners} tone={run.winners === 1 ? 'good' : 'bad'} />
            <Stat label="member_count" value={run.memberCount} tone={run.invariantHolds ? undefined : 'bad'} />
            <Stat label="Real members" value={run.actualMembers} tone={run.invariantHolds ? undefined : 'bad'} />
            <Stat label="Whole race" value={`${run.elapsedMs} ms`} />
          </dl>
          <div className="mt-4"><Histogram results={run.results} /></div>
          <p className="mt-3 text-xs text-ink-mute">The throwaway team and its bots were deleted before this result was sent.</p>
        </Card>
      )}
    </div>
  );
}
