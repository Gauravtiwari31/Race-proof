import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type OpsStats } from '../api';
import { Card, Skeleton } from '../components/ui';

export function Ops() {
  // Behind a load balancer each poll may reach a different replica, so keep the latest from each.
  const [replicas, setReplicas] = useState<Record<string, OpsStats>>({});
  const stats = useQuery({ queryKey: ['ops'], queryFn: () => api<OpsStats>('/ops/stats'), refetchInterval: 1000, staleTime: 0 });

  useEffect(() => {
    if (stats.data) setReplicas((all) => ({ ...all, [stats.data.replica]: stats.data }));
  }, [stats.data]);

  const list = Object.values(replicas).sort((a, b) => a.replica.localeCompare(b.replica));

  return (
    <div className="mx-auto max-w-4xl">
      <p className="eyebrow">Observability</p>
      <h1 className="display mt-2 text-5xl">Ops panel</h1>
      <p className="mt-3 text-ink-soft">Live numbers from each API replica. Prometheus scrapes the same counters from /metrics.</p>
      <div className="mt-4 flex flex-col gap-4">
        {list.length === 0 && <Skeleton lines={1} />}
        {list.map((r) => (
          <Card key={r.replica}>
            <h2 className="flex items-center gap-2 font-mono text-sm break-all text-ink-soft"><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-live" />Replica {r.replica}</h2>
            <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: 'p95 latency', value: `${r.p95Ms} ms` },
                { label: 'Open streams', value: r.openStreams },
                { label: 'Joins per second', value: r.joinsPerSecond.toFixed(1) },
                { label: 'Conflicts per second', value: r.conflictsPerSecond.toFixed(1) },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-line-soft bg-bg p-3">
                  <dt className="eyebrow">{s.label}</dt>
                  <dd className="display mt-1.5 text-3xl">{s.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-ink-mute">Over the last {r.sampleSize} requests. Up for {r.uptimeSeconds} s. Rates cover the last 10 s.</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
