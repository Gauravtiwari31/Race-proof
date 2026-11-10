import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, sendIntent, type HistoryEvent, type Invite, type JoinRequest, type LiveEvent, type Team } from '../api';
import { useMe, useStanding } from '../App';
import { Button, Card, Confirm, Dialog, EmptyState, ErrorState, Field, LiveBadge, SeatSlots, Skeleton, Tags, useToast } from '../components/ui';
import { useAnnounce, useLiveEvents } from '../live';

const describe = (event: HistoryEvent, names: Record<string, string>) => {
  const who = (id: string | null) => (id && names[id]) || 'Someone';
  switch (event.action) {
    case 'team.created': return `${who(event.actor_id)} created the team`;
    case 'team.deleted': return `${who(event.userId)} left last, so the team was deleted`;
    case 'member.joined': return `${who(event.userId)} joined`;
    case 'member.left': return `${who(event.userId)} left${event.promoted ? `; ${who(event.promoted)} became leader` : ''}`;
    case 'member.removed': return `${who(event.actor_id)} removed ${who(event.userId)}`;
    case 'leader.transferred': return `${who(event.from)} handed leadership to ${who(event.to)}`;
    default: return null; // invites and requests do not change who is in the team
  }
};

/** Rebuilds the team as it stood after each event. Pure, so the scrubber is only an index into this. */
function replay(events: HistoryEvent[]) {
  let members: { id: string; leader: boolean }[] = [];
  const frames: { event: HistoryEvent; members: typeof members }[] = [];
  for (const e of events) {
    if (e.action === 'team.created') members = [{ id: e.userId ?? e.actor_id, leader: true }];
    else if (e.action === 'member.joined' && e.userId) members = [...members, { id: e.userId, leader: false }];
    else if (e.action === 'member.left' || e.action === 'member.removed') {
      members = members.filter((m) => m.id !== e.userId).map((m) => (m.id === e.promoted ? { ...m, leader: true } : m));
    } else if (e.action === 'leader.transferred') members = members.map((m) => ({ ...m, leader: m.id === e.to }));
    else if (e.action === 'team.deleted') members = [];
    else continue;
    frames.push({ event: e, members });
  }
  return frames;
}

function TimeMachine({ teamId }: { teamId: string }) {
  const history = useQuery({
    queryKey: ['history', teamId],
    // Follows the cursor to the end, so a long-lived team still replays from its first event.
    queryFn: async () => {
      type Page = { events: HistoryEvent[]; names: Record<string, string>; nextCursor: number | null };
      const all: Page = { events: [], names: {}, nextCursor: null };
      let after = 0;
      for (;;) {
        const page = await api<Page>(`/teams/${teamId}/history?after=${after}`);
        all.events.push(...page.events);
        Object.assign(all.names, page.names);
        if (page.nextCursor === null) return all;
        after = page.nextCursor;
      }
    },
  });
  const frames = useMemo(() => replay(history.data?.events ?? []), [history.data]);
  const [picked, setPicked] = useState<number | null>(null);
  if (!history.data || frames.length === 0) return null;

  const index = Math.min(picked ?? frames.length - 1, frames.length - 1);
  const frame = frames[index]!;
  const names = history.data.names;

  return (
    <Card>
      <h2 className="display text-xl">Team time machine</h2>
      <p className="mt-0.5 text-sm text-ink-mute">Replayed from the append-only audit log.</p>
      <label htmlFor="scrubber" className="mt-3 block text-sm text-ink-soft">
        Event {index + 1} of {frames.length}
      </label>
      <input
        id="scrubber"
        type="range"
        min={0}
        max={frames.length - 1}
        value={index}
        onChange={(e) => setPicked(Number(e.target.value))}
        aria-valuetext={describe(frame.event, names) ?? undefined}
        className="mt-1 h-11 w-full [accent-color:var(--color-accent)]"
      />
      <p className="text-sm">{describe(frame.event, names)}</p>
      <p className="mt-0.5 font-mono text-xs text-ink-mute">{new Date(frame.event.at).toLocaleString()}</p>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Team at this moment">
        {frame.members.length === 0 && <li className="text-sm text-ink-mute">No members</li>}
        {frame.members.map((m) => (
          <li key={m.id} className={`rounded border px-2 py-1 text-xs ${m.leader ? 'border-accent/70 text-accent' : 'border-line-soft text-ink-soft'}`}>
            {names[m.id] ?? 'Someone'}{m.leader ? ' (leader)' : ''}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Invites({ teamId }: { teamId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const key = ['invites', teamId];
  const invites = useQuery({ queryKey: key, queryFn: () => api<{ invites: Invite[] }>(`/teams/${teamId}/invites`) });
  const [fresh, setFresh] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<{ code: string }>(`/teams/${teamId}/invites`, { method: 'POST', body: { expiresInHours: 48 } }),
    onSuccess: ({ code }) => {
      setFresh(code);
      void client.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast(err.message, 'error'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/teams/${teamId}/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
    onError: (err) => toast(err.message, 'error'),
  });

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      toast('Code copied.');
    } catch {
      toast('Copy failed. Select the code and copy it by hand.', 'error');
    }
  };

  const active = invites.data?.invites.filter((i) => !i.revokedAt && new Date(i.expiresAt) > new Date()) ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="display text-xl">Invite codes</h2>
        <Button tone="primary" busy={create.isPending} onClick={() => create.mutate()}>New code</Button>
      </div>
      {fresh && (
        <div className="rise mt-3 rounded-md border border-accent/60 bg-bg p-3">
          <p className="text-xs text-ink-mute">Shown once. Only a hash is stored, so copy it now.</p>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <code data-testid="invite-code" className="font-mono text-lg break-all text-accent">{fresh}</code>
            <Button onClick={() => void copy()}>Copy</Button>
          </div>
        </div>
      )}
      {active.length > 0 ? (
        <ul className="mt-3 divide-y divide-line-soft">
          {active.map((invite) => (
            <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="text-ink-soft">
                Used {invite.uses}{invite.maxUses ? ` of ${invite.maxUses}` : ''} times. Expires {new Date(invite.expiresAt).toLocaleString()}.
              </span>
              <Button tone="danger" onClick={() => revoke.mutate(invite.id)} aria-label={`Revoke code expiring ${new Date(invite.expiresAt).toLocaleString()}`}>Revoke</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-mute">No active codes.</p>
      )}
    </Card>
  );
}

function Requests({ teamId }: { teamId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const key = ['requests', teamId];
  const requests = useQuery({ queryKey: key, queryFn: () => api<{ requests: JoinRequest[] }>(`/teams/${teamId}/requests`) });

  const decide = useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict: 'accept' | 'decline' }) => sendIntent(`/requests/${id}/${verdict}`, { method: 'POST' }),
    // Optimistic: the request leaves the list and the seat fills right away; a conflict undoes both.
    onMutate: async ({ id, verdict }) => {
      await client.cancelQueries({ queryKey: key });
      await client.cancelQueries({ queryKey: ['team', teamId] });
      const before = { requests: client.getQueryData<{ requests: JoinRequest[] }>(key), team: client.getQueryData<Team>(['team', teamId]) };
      const request = before.requests?.requests.find((r) => r.id === id);
      client.setQueryData<{ requests: JoinRequest[] }>(key, (d) => d && { requests: d.requests.filter((r) => r.id !== id) });
      if (verdict === 'accept' && request) {
        client.setQueryData<Team>(['team', teamId], (t) =>
          t && { ...t, memberCount: t.memberCount + 1, members: [...t.members, { userId: request.userId, name: request.name, role: 'member', optimistic: true }] },
        );
      }
      return before;
    },
    onError: (err, _vars, before) => {
      if (before) {
        client.setQueryData(key, before.requests);
        client.setQueryData(['team', teamId], before.team);
      }
      toast(err instanceof ApiError && err.code === 'TEAM_FULL' ? 'Someone was faster: that was the last seat.' : err.message, 'error');
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: ['team', teamId] });
    },
  });

  const list = requests.data?.requests ?? [];
  return (
    <Card>
      <h2 className="display text-xl">Join requests</h2>
      {list.length === 0 ? (
        <p className="mt-2 text-sm text-ink-mute">No pending requests.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line-soft">
          {list.map((r) => (
            <li key={r.id} className="py-3">
              <p className="font-medium">{r.name}</p>
              {r.message && <p className="mt-0.5 text-sm text-ink-soft">{r.message}</p>}
              <div className="mt-2"><Tags items={r.skills} /></div>
              <div className="mt-3 flex gap-2">
                <Button tone="primary" onClick={() => decide.mutate({ id: r.id, verdict: 'accept' })} aria-label={`Accept ${r.name}`}>Accept</Button>
                <Button onClick={() => decide.mutate({ id: r.id, verdict: 'decline' })} aria-label={`Decline ${r.name}`}>Decline</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The leader renames the team or changes the skills it wants, which also drive its suggestions. */
function EditTeamDialog({ team, open, onOpenChange }: { team: Team; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(team.name);
  const [lookingFor, setLookingFor] = useState(team.lookingFor.join(', '));
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(team.name);
    setLookingFor(team.lookingFor.join(', '));
    setNameError(null);
  }, [open, team.name, team.lookingFor]);

  const save = useMutation({
    mutationFn: () =>
      sendIntent<Team>(`/teams/${team.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), lookingFor: lookingFor.split(',').map((s) => s.trim()).filter(Boolean) },
      }),
    onSuccess: async () => {
      onOpenChange(false);
      toast('Team updated.');
      await client.invalidateQueries({ queryKey: ['team', team.id] });
      await client.invalidateQueries({ queryKey: ['board'] });
      await client.invalidateQueries({ queryKey: ['suggestions'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'TEAM_NAME_TAKEN') setNameError(err.message);
      else toast(err.message, 'error');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Edit team" description="Everyone on the board sees the change straight away.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setNameError(null);
          save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Team name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={nameError} />
        <Field label="Skills you are looking for" hint="Comma separated. This drives your suggestions." value={lookingFor} onChange={(e) => setLookingFor(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" tone="primary" busy={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A non-member's way in: a code with an optimistic seat, or a request to the leader. */
function JoinPanel({ team }: { team: Team }) {
  const client = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const standing = useStanding(team.hackathonId).data;
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const navigate = useNavigate();
  const key = ['team', team.id];

  const join = useMutation({
    mutationFn: () => sendIntent<{ teamId: string }>('/invites/redeem', { method: 'POST', body: { code } }),
    onMutate: async () => {
      setError(null);
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData<Team>(key);
      client.setQueryData<Team>(key, (t) =>
        t && { ...t, memberCount: t.memberCount + 1, members: [...t.members, { userId: me!.id, name: me!.name, role: 'member', optimistic: true }] },
      );
      return { before };
    },
    onError: (err, _vars, context) => {
      const lostRace = err instanceof ApiError && err.code === 'TEAM_FULL';
      // Let the placeholder animate out before the snapshot comes back.
      setRollingBack(true);
      setTimeout(() => {
        client.setQueryData(key, context?.before);
        setRollingBack(false);
      }, 400);
      setError(lostRace ? 'Someone was faster: the last seat just went.' : err.message);
    },
    onSuccess: ({ teamId }, _vars, context) => {
      setCode('');
      if (teamId !== team.id) {
        // The code belonged to another team: drop the seat drawn here and go where the person landed.
        client.setQueryData(key, context?.before);
        toast('That code was for another team. Taking you there.');
        navigate(`/teams/${teamId}`);
        return;
      }
      toast('You are in.');
    },
    onSettled: () => {
      setTimeout(() => {
        void client.invalidateQueries({ queryKey: key });
        void client.invalidateQueries({ queryKey: ['standing'] });
        void client.invalidateQueries({ queryKey: ['history', team.id] });
      }, 450);
    },
  });

  const request = useMutation({
    mutationFn: () => sendIntent(`/teams/${team.id}/requests`, { method: 'POST', body: message.trim() ? { message: message.trim() } : {} }),
    onSuccess: () => {
      setRequestOpen(false);
      setMessage('');
      toast('Request sent to the leader.');
      void client.invalidateQueries({ queryKey: ['standing'] });
    },
    onError: (err) => toast(err.message, 'error'),
  });

  const pending = Boolean(standing?.pendingTeamIds.includes(team.id));
  const requestId = standing?.pendingRequests?.[team.id];
  const wasPending = useRef(pending);
  // A pending request that vanishes while the person is still outside the team was declined.
  useEffect(() => {
    if (wasPending.current && !pending && standing && !standing.teamId) toast('The leader declined your request.', 'error');
    wasPending.current = pending;
  }, [pending, standing, toast]);

  const withdraw = useMutation({
    mutationFn: () => sendIntent(`/requests/${requestId}/cancel`, { method: 'POST' }),
    onSuccess: async () => {
      wasPending.current = false;
      toast('Request withdrawn.');
      await client.invalidateQueries({ queryKey: ['standing'] });
    },
    onError: (err) => toast(err.message, 'error'),
  });

  if (standing?.teamId) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    join.mutate();
  };

  return (
    <Card className={rollingBack ? 'relative' : ''}>
      <h2 className="display text-xl">Join this team</h2>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
        <Field label="Invite code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="TEAM-7KQ2-M9XD-H4" autoComplete="off" spellCheck={false} required error={error} className="font-mono" />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" tone="primary" busy={join.isPending}>Join with code</Button>
          <Button onClick={() => setRequestOpen(true)} disabled={pending}>{pending ? 'Request pending' : 'Ask to join'}</Button>
          {pending && requestId && (
            <Button tone="ghost" busy={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw request</Button>
          )}
        </div>
      </form>
      <Dialog open={requestOpen} onOpenChange={setRequestOpen} title={`Ask to join ${team.name}`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Message to the leader" maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} hint="Optional." />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRequestOpen(false)}>Cancel</Button>
            <Button type="submit" tone="primary" busy={request.isPending}>Send request</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

/** Keyed by id, so moving between teams starts every piece of page state afresh. */
export function TeamPage() {
  const { id = '' } = useParams();
  return <TeamView key={id} id={id} />;
}

function TeamView({ id }: { id: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const announce = useAnnounce();
  const me = useMe().data;
  const key = ['team', id];
  const team = useQuery({ queryKey: key, queryFn: () => api<Team>(`/teams/${id}`) });
  const [gone, setGone] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const [promoting, setPromoting] = useState<{ userId: string; name: string } | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (team.data) document.title = `${team.data.name} · Lastseat`;
  }, [team.data?.name]);

  const live = useLiveEvents({ team: id }, (event: LiveEvent) => {
    if (event.userId && event.userId === me?.id) {
      void client.invalidateQueries({ queryKey: ['standing'] });
      if (event.action === 'member.removed') toast('The leader removed you from this team.', 'error');
      if (event.action === 'member.joined') toast('You are in.');
    }
    if (event.action.startsWith('request.')) void client.invalidateQueries({ queryKey: ['standing'] });
    if (event.action === 'team.deleted') {
      setGone(true);
      void client.invalidateQueries({ queryKey: ['standing'] });
    }
    if (event.version !== null && event.memberCount !== undefined) {
      client.setQueryData<Team>(key, (t) => (t && event.version! > t.version ? { ...t, memberCount: event.memberCount!, version: event.version! } : t));
      announce(event.action === 'member.joined' ? 'Someone joined the team' : 'Someone left the team');
    }
    void client.invalidateQueries({ queryKey: event.action.startsWith('request.') ? ['requests', id] : event.action.startsWith('invite.') ? ['invites', id] : key });
    void client.invalidateQueries({ queryKey: ['history', id] });
  });

  const invalidateAll = async () => {
    await client.invalidateQueries({ queryKey: key });
    await client.invalidateQueries({ queryKey: ['standing'] });
    await client.invalidateQueries({ queryKey: ['board'] });
    await client.invalidateQueries({ queryKey: ['history', id] });
  };

  const leave = useMutation({
    mutationFn: () => sendIntent<{ teamDeleted: boolean }>(`/teams/${id}/leave`, { method: 'POST' }),
    onSuccess: async ({ teamDeleted }) => {
      toast(teamDeleted ? 'You left and the team was deleted.' : 'You left the team.');
      await client.invalidateQueries();
      navigate('/');
    },
    onError: (err) => {
      setConfirmLeave(false);
      toast(err.message, 'error');
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => sendIntent(`/teams/${id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setRemoving(null);
      await invalidateAll();
    },
    onError: (err) => toast(err.message, 'error'),
  });
  const transfer = useMutation({
    mutationFn: (userId: string) => sendIntent(`/teams/${id}/transfer`, { method: 'POST', body: { userId } }),
    onSuccess: async () => {
      setPromoting(null);
      await invalidateAll();
    },
    onError: (err) => toast(err.message, 'error'),
  });

  if (team.isLoading) return <Skeleton />;
  const notFound = team.error instanceof ApiError && (team.error.status === 404 || team.error.status === 400);
  if (!gone && team.isError && !team.data && !notFound) return <ErrorState error={team.error} onRetry={() => void team.refetch()} />;
  if (gone || !team.data) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState title="This team no longer exists.">
          <Link to="/" className="text-ink underline underline-offset-2">Back to the board</Link>
        </EmptyState>
        <TimeMachine teamId={id} />
      </div>
    );
  }

  const t = team.data;
  const mine = t.members.find((m) => m.userId === me?.id && !m.optimistic);
  const isLeader = mine?.role === 'leader';
  const needed = Math.max(0, t.minSize - t.memberCount);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px] lg:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        <Card flush className="overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-4 p-5 sm:p-6">
            <div className="min-w-0">
              <p className="eyebrow">Boarding pass · {t.minSize} to {t.maxSize} seats</p>
              <h1 className="display mt-2 text-4xl break-words sm:text-5xl">{t.name}</h1>
              <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className={t.status === 'forming' ? 'text-ink-soft' : 'font-semibold text-live'}>
                  {t.status === 'forming' ? `Forming: needs ${needed} more to be eligible` : 'Ready'}
                </span>
                <LiveBadge state={live} />
              </p>
            </div>
            <div className="sm:text-right">
              <p className="eyebrow">Taken</p>
              <p data-testid="seat-count" className="display mt-1 text-3xl text-accent">{t.memberCount}/{t.maxSize} seats</p>
            </div>
          </div>
          <div className="perforation" aria-hidden="true" />
          <div className="flex flex-wrap items-end justify-between gap-4 p-5 sm:p-6">
            <SeatSlots members={t.members} memberCount={t.memberCount} maxSize={t.maxSize} />
            {t.lookingFor.length > 0 && (
              <div className="min-w-0">
                <p className="eyebrow mb-1.5">Looking for</p>
                <Tags items={t.lookingFor} />
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="display text-xl">Members</h2>
            {isLeader && <Button tone="ghost" onClick={() => setEditing(true)}>Edit team</Button>}
          </div>
          <ul className="mt-2 divide-y divide-line-soft">
            {t.members.map((m, i) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="flex min-w-0 items-center gap-3 break-words">
                  <span aria-hidden="true" className="w-4 font-mono text-xs text-ink-mute">{'ABCDEFGHJK'[i] ?? ''}</span>
                  <span>{m.name}</span>
                  {m.role === 'leader' && <span className="rounded border border-accent/70 px-1.5 py-0.5 font-mono text-[11px] tracking-[0.12em] text-accent uppercase">Leader</span>}
                  {m.optimistic && <span className="font-mono text-[11px] tracking-[0.12em] text-ink-mute uppercase">Confirming</span>}
                </span>
                {isLeader && m.userId !== me?.id && !m.optimistic && (
                  <span className="flex flex-wrap gap-2">
                    <Button onClick={() => setPromoting({ userId: m.userId, name: m.name })} aria-label={`Make ${m.name} leader`}>Make leader</Button>
                    <Button tone="danger" onClick={() => setRemoving({ userId: m.userId, name: m.name })} aria-label={`Remove ${m.name}`}>Remove</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {mine && (
            <div className="mt-3 border-t border-line-soft pt-4">
              <Button tone="danger" busy={leave.isPending} onClick={() => setConfirmLeave(true)}>
                {t.memberCount === 1 ? 'Leave and delete the team' : 'Leave team'}
              </Button>
              {isLeader && t.memberCount > 1 && <p className="mt-1.5 text-xs text-ink-mute">Leadership passes to the longest-standing member.</p>}
            </div>
          )}
        </Card>
        <TimeMachine teamId={id} />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {!mine && <JoinPanel team={t} />}
        {isLeader && <Invites teamId={id} />}
        {isLeader && <Requests teamId={id} />}
      </div>

      <Confirm
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title={t.memberCount === 1 ? 'Delete this team?' : 'Leave this team?'}
        description={
          t.memberCount === 1
            ? 'You are the last member, so leaving deletes the team. Its history stays in the audit log.'
            : isLeader
              ? 'Leadership passes to the longest-standing member. You can ask to rejoin later if there is a seat.'
              : 'Your seat opens for someone else straight away.'
        }
        confirmLabel={t.memberCount === 1 ? 'Leave and delete' : 'Leave team'}
        busy={leave.isPending}
        onConfirm={() => leave.mutate()}
      />
      <Confirm
        open={promoting !== null}
        onOpenChange={(open) => !open && setPromoting(null)}
        title={`Make ${promoting?.name ?? 'them'} leader?`}
        description="You become a member. Only the new leader can accept requests, make codes and remove people."
        confirmLabel="Hand over"
        busy={transfer.isPending}
        onConfirm={() => promoting && transfer.mutate(promoting.userId)}
      />
      {isLeader && <EditTeamDialog team={t} open={editing} onOpenChange={setEditing} />}
      <Confirm
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? 'this member'}?`}
        description="Their seat opens straight away. The removal is recorded in the audit log."
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
    </div>
  );
}
