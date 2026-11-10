import * as Tabs from '@radix-ui/react-tabs';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, sendIntent, type BoardPerson, type BoardTeam, type LiveEvent } from '../api';
import { useHackathon, useStanding } from '../App';
import { Button, Dialog, EmptyState, ErrorState, Field, Flap, LiveBadge, SeatSlots, Skeleton, Tags, useToast } from '../components/ui';
import { JoinByCodeDialog } from '../components/palette';
import { useAnnounce, useLiveEvents } from '../live';

interface TeamsPage {
  teams: BoardTeam[];
  nextCursor: string | null;
}

interface PeoplePage {
  people: BoardPerson[];
  nextCursor: string | null;
}

/** The state a row shows in its last column, the way a departures board says Boarding or Closed. */
function statusOf(open: number) {
  if (open <= 0) return { label: 'Full', className: 'text-ink-mute' };
  if (open === 1) return { label: 'Last seat', className: 'blink text-accent' };
  return { label: 'Boarding', className: 'text-live' };
}

const ROW_AREAS =
  "[grid-template-areas:'name_flap'_'seats_status'_'tags_tags'] md:[grid-template-areas:'name_seats_tags_flap_status']";

function TeamRow({ team, flashId }: { team: BoardTeam; flashId?: number }) {
  const open = team.maxSize - team.memberCount;
  const status = statusOf(open);
  const ref = useRef<HTMLAnchorElement>(null);
  // Replays the highlight in place: remounting the row would drop keyboard focus and shift taps.
  useEffect(() => {
    const el = ref.current;
    if (!flashId || !el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }, [flashId]);
  return (
    <li>
      <Link
        ref={ref}
        to={`/teams/${team.id}`}
        className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 border-b border-line-soft px-3 py-4 transition-colors hover:bg-surface md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_4.5rem_6.5rem] md:px-4 ${ROW_AREAS}`}
      >
        <h3 className="display min-w-0 text-[22px] break-words transition-colors [grid-area:name] group-hover:text-accent">{team.name}</h3>
        <div className="[grid-area:seats]">
          <SeatSlots members={team.members} memberCount={team.memberCount} maxSize={team.maxSize} size="sm" />
        </div>
        <div className="min-w-0 [grid-area:tags]">
          {team.lookingFor.length > 0 ? <Tags items={team.lookingFor} /> : <span className="text-sm text-ink-mute">Open to anyone</span>}
        </div>
        <Flap className="justify-self-end text-lg [grid-area:flap] md:justify-self-start" value={open} label={open === 0 ? 'Full' : `${open} open`} mute={open === 0} />
        <span className={`justify-self-end font-mono text-xs font-semibold tracking-[0.14em] uppercase [grid-area:status] md:justify-self-start ${status.className}`}>{status.label}</span>
      </Link>
    </li>
  );
}

function BoardHeader() {
  return (
    <div aria-hidden="true" className="eyebrow hidden grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_4.5rem_6.5rem] gap-x-4 border-b border-line px-4 pb-2 md:grid">
      <span>Team</span>
      <span>Crew</span>
      <span>Looking for</span>
      <span>Open</span>
      <span>Status</span>
    </div>
  );
}

function PersonCard({ person }: { person: BoardPerson }) {
  return (
    <li className="flex flex-col rounded-xl border border-line-soft bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="display min-w-0 text-xl break-words">{person.name}</h3>
        {person.primaryRole && <span className="shrink-0 font-mono text-[11px] tracking-[0.14em] text-accent uppercase">{person.primaryRole}</span>}
      </div>
      {person.pitch && <p className="mt-1 text-sm text-ink-soft">{person.pitch}</p>}
      <div className="mt-3"><Tags items={person.skills} /></div>
      <p className="mt-auto pt-3 font-mono text-xs text-ink-mute">{person.timezone}</p>
    </li>
  );
}

function CreateTeamDialog({ hackathonId, open, onOpenChange }: { hackathonId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [lookingFor, setLookingFor] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      sendIntent<{ teamId: string }>(`/hackathons/${hackathonId}/teams`, {
        method: 'POST',
        body: { name, lookingFor: lookingFor.split(',').map((s) => s.trim()).filter(Boolean) },
      }),
    onSuccess: async ({ teamId }) => {
      onOpenChange(false);
      await client.invalidateQueries();
      navigate(`/teams/${teamId}`);
    },
    // Only a name problem belongs on the name field; anything else is about the whole form.
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'TEAM_NAME_TAKEN') setNameError(err.message);
      else setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNameError(null);
    setError(null);
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Create a team" description="You become its leader. You can only be in one team per hackathon.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Team name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={nameError} />
        <Field label="Skills you are looking for" hint="Comma separated. This drives your suggestions." value={lookingFor} onChange={(e) => setLookingFor(e.target.value)} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" tone="primary" busy={create.isPending}>Create team</Button>
        </div>
      </form>
    </Dialog>
  );
}

function LookingControls({ hackathonId }: { hackathonId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const standing = useStanding(hackathonId).data;
  const [dialog, setDialog] = useState(false);
  const [pitch, setPitch] = useState('');

  const update = useMutation({
    mutationFn: (body: { looking: boolean; pitch?: string }) => sendIntent(`/hackathons/${hackathonId}/participation`, { method: 'PUT', body }),
    onSuccess: async (_data, body) => {
      setDialog(false);
      toast(body.looking ? 'You are on the board.' : 'You are off the board.');
      await client.invalidateQueries({ queryKey: ['standing'] });
      await client.invalidateQueries({ queryKey: ['board', hackathonId, 'people'] });
    },
    onError: (err) => toast(err.message, 'error'),
  });

  if (!standing || standing.teamId) return null;
  if (standing.looking) {
    return <Button busy={update.isPending} onClick={() => update.mutate({ looking: false })}>Stop looking</Button>;
  }
  return (
    <>
      <Button onClick={() => setDialog(true)}>I am looking for a team</Button>
      <Dialog open={dialog} onOpenChange={setDialog} title="Join the board" description="Teams can find you here. You leave it automatically when you join a team.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ looking: true, ...(pitch.trim() ? { pitch: pitch.trim() } : {}) });
          }}
          className="flex flex-col gap-4"
        >
          <Field label="One-line pitch" maxLength={280} value={pitch} onChange={(e) => setPitch(e.target.value)} hint="Optional." />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button type="submit" tone="primary" busy={update.isPending}>Add me</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function Board() {
  const client = useQueryClient();
  const announce = useAnnounce();
  const hackathon = useHackathon();
  const id = hackathon.data?.id;
  const standing = useStanding(id).data;
  const [skill, setSkill] = useState('');
  const [appliedSkill, setAppliedSkill] = useState('');
  const [name, setName] = useState('');
  const [appliedName, setAppliedName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  const refreshTimer = useRef<number | null>(null);

  // Filter as you type, without firing a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedSkill(skill.trim());
      setAppliedName(name.trim());
    }, 250);
    return () => clearTimeout(t);
  }, [skill, name]);

  const query = appliedSkill ? `&skill=${encodeURIComponent(appliedSkill)}` : '';
  const nameQuery = appliedName ? `&q=${encodeURIComponent(appliedName)}` : '';
  const teamsKey = ['board', id, 'teams', appliedSkill, appliedName];

  const teams = useInfiniteQuery({
    queryKey: teamsKey,
    enabled: Boolean(id),
    initialPageParam: '',
    queryFn: ({ pageParam }) => api<TeamsPage>(`/hackathons/${id}/board/teams?limit=30${query}${nameQuery}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const people = useInfiniteQuery({
    queryKey: ['board', id, 'people', appliedSkill],
    enabled: Boolean(id),
    initialPageParam: '',
    queryFn: ({ pageParam }) => api<PeoplePage>(`/hackathons/${id}/board/people?limit=30${query}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const live = useLiveEvents({ hackathon: id }, (event: LiveEvent) => {
    // Apply the delta at once when it is newer than what we hold; an older one is simply dropped.
    if (event.teamId && event.version !== null && event.memberCount !== undefined) {
      client.setQueryData<InfiniteData<TeamsPage>>(teamsKey, (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            teams: page.teams.map((team) =>
              team.id === event.teamId && event.version! > team.version
                ? { ...team, memberCount: event.memberCount!, version: event.version! }
                : team,
            ),
          })),
        },
      );
      setFlashes((f) => ({ ...f, [event.teamId!]: event.id }));
      announce('A team seat changed');
    }
    // Names and new teams need the snapshot; batch that so a burst causes one refetch.
    refreshTimer.current ??= window.setTimeout(() => {
      refreshTimer.current = null;
      void client.invalidateQueries({ queryKey: ['board', id] });
      void client.invalidateQueries({ queryKey: ['standing', id] });
    }, 1200);
  });

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  if (hackathon.isLoading) return <Skeleton />;
  if (!hackathon.data) return <EmptyState title="No hackathon is running yet." />;

  const teamList = teams.data?.pages.flatMap((p) => p.teams) ?? [];
  const peopleList = people.data?.pages.flatMap((p) => p.people) ?? [];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Departures board</p>
          <h1 className="display mt-2 text-5xl break-words sm:text-6xl">{hackathon.data.name}</h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
            <span>Teams of {hackathon.data.minSize} to {hackathon.data.maxSize}</span>
            <span>One team per person</span>
            <LiveBadge state={live} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {standing?.teamId ? (
            <Link to={`/teams/${standing.teamId}`} className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-sm font-semibold tracking-wide text-on-accent hover:bg-accent-hi">Go to my team</Link>
          ) : (
            <>
              <LookingControls hackathonId={hackathon.data.id} />
              <Button onClick={() => setJoinOpen(true)}>Join with a code</Button>
              <Button tone="primary" onClick={() => setCreateOpen(true)}>Create a team</Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-2">
        <Field label="Search teams" type="search" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <Field label="Filter by skill" placeholder="postgres, react" value={skill} onChange={(e) => setSkill(e.target.value)} autoComplete="off" />
      </div>

      <Tabs.Root defaultValue="teams" className="mt-5">
        <Tabs.List aria-label="Board" className="flex gap-2 border-b border-line-soft">
          {[{ value: 'teams', label: 'Teams with open seats' }, { value: 'people', label: 'People looking' }].map((tab) => (
            <Tabs.Trigger key={tab.value} value={tab.value} className="-mb-px min-h-11 border-b-2 border-transparent px-3 font-display text-base font-semibold tracking-[0.06em] text-ink-mute uppercase transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink">
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="teams" className="mt-4">
          {teams.isLoading ? <Skeleton /> : teams.isError && !teams.data ? (
            <ErrorState error={teams.error} onRetry={() => void teams.refetch()} />
          ) : teamList.length === 0 ? (
            <EmptyState title={appliedName || appliedSkill ? 'No open team matches that search.' : 'No teams with open seats yet.'}>Create one and invite people.</EmptyState>
          ) : (
            <div className="rounded-xl border border-line-soft bg-bg pt-3">
              <BoardHeader />
              <ul>
                {teamList.map((team) => <TeamRow key={team.id} team={team} flashId={flashes[team.id]} />)}
              </ul>
            </div>
          )}
          {teams.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button busy={teams.isFetchingNextPage} onClick={() => void teams.fetchNextPage()}>Load more teams</Button>
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="people" className="mt-4">
          {people.isLoading ? <Skeleton /> : people.isError && !people.data ? (
            <ErrorState error={people.error} onRetry={() => void people.refetch()} />
          ) : peopleList.length === 0 ? (
            <EmptyState title={appliedSkill ? `Nobody with ${appliedSkill} is looking.` : 'Nobody is looking right now.'} />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {peopleList.map((person) => <PersonCard key={person.id} person={person} />)}
            </ul>
          )}
          {people.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button busy={people.isFetchingNextPage} onClick={() => void people.fetchNextPage()}>Load more people</Button>
            </div>
          )}
        </Tabs.Content>
      </Tabs.Root>

      <CreateTeamDialog hackathonId={hackathon.data.id} open={createOpen} onOpenChange={setCreateOpen} />
      <JoinByCodeDialog open={joinOpen} onOpenChange={setJoinOpen} />
    </>
  );
}

