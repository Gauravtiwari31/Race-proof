import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ScoreParts, type Suggestion } from '../api';
import { useHackathon, useStanding } from '../App';
import { Card, EmptyState, ErrorState, Skeleton, Tags } from '../components/ui';

// Fixed to the part, never to its rank: the same colour always means the same thing.
const PARTS: Array<{ key: Exclude<keyof ScoreParts, 'redundancy'>; label: string; max: number; color: string }> = [
  { key: 'coverage', label: 'Skills', max: 0.5, color: 'var(--color-part-1)' },
  { key: 'tz', label: 'Time overlap', max: 0.3, color: 'var(--color-part-2)' },
  { key: 'role', label: 'Role', max: 0.15, color: 'var(--color-part-3)' },
  { key: 'recency', label: 'Active', max: 0.05, color: 'var(--color-part-4)' },
];

function ScoreBar({ parts }: { parts: ScoreParts }) {
  return (
    <div className="flex h-2 w-full gap-0.5 rounded-full bg-bg" aria-hidden="true">
      {PARTS.filter((p) => parts[p.key] > 0).map((p) => (
        <div key={p.key} title={`${p.label}: +${parts[p.key]}`} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(parts[p.key] / 1) * 100}%`, background: p.color }} />
      ))}
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-mute" aria-label="Score parts">
      {PARTS.map((p) => (
        <li key={p.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
          {p.label} (up to {p.max})
        </li>
      ))}
    </ul>
  );
}

function SuggestionCard({ suggestion, isTeam }: { suggestion: Suggestion; isTeam: boolean }) {
  const e = suggestion.explanation;
  const reasons = [
    e.covers.length ? `Covers ${e.covers.join(', ')}` : null,
    e.tzOverlapHours > 0 ? `${e.tzOverlapHours} h overlap` : 'No time overlap',
    e.fillsRole ? `Adds a missing ${e.fillsRole} role` : null,
    e.alreadyHave.length ? `Already on the team: ${e.alreadyHave.join(', ')} (${e.parts.redundancy})` : null,
    e.parts.recency > 0 ? 'Active in the last 24 h' : null,
  ].filter(Boolean);

  return (
    <li>
      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="display min-w-0 text-2xl break-words">
            {isTeam ? suggestion.name : <Link className="underline decoration-line underline-offset-4 hover:text-accent" to={`/teams/${suggestion.id}`}>{suggestion.name}</Link>}
          </h2>
          <span className="shrink-0 font-mono text-lg font-semibold text-accent" aria-label={`Score ${suggestion.score}`}>{suggestion.score.toFixed(2)}</span>
        </div>
        <div className="mt-2"><ScoreBar parts={e.parts} /></div>
        <p className="mt-2 text-sm text-ink-soft">{reasons.join('. ')}.</p>
        {isTeam && suggestion.pitch && <p className="mt-1 text-sm text-ink-mute">{suggestion.pitch}</p>}
        <div className="mt-2"><Tags items={suggestion.skills ?? suggestion.lookingFor ?? []} highlight={e.covers} /></div>
      </Card>
    </li>
  );
}

export function Suggestions() {
  const hackathon = useHackathon().data;
  const standing = useStanding(hackathon?.id).data;
  const forTeam = Boolean(standing?.teamId);

  const suggestions = useQuery({
    queryKey: ['suggestions', hackathon?.id, forTeam],
    enabled: Boolean(hackathon && standing),
    queryFn: () => api<{ suggestions: Suggestion[] }>(`/hackathons/${hackathon!.id}/suggestions?for=${forTeam ? 'team' : 'user'}&limit=10`),
  });

  return (
    <div className="mx-auto max-w-3xl">
      <p className="eyebrow">Ranked and explained</p>
      <h1 className="display mt-2 text-5xl">{forTeam ? 'People for your team' : 'Teams for you'}</h1>
      <p className="mt-3 text-ink-soft">
        {forTeam ? 'Ranked by what they add to your team.' : 'Ranked by how much your skills are wanted.'} Every score is broken down, so you can see why.
        {forTeam && standing?.role === 'leader' && (
          <> Found someone? <Link className="text-accent underline underline-offset-4" to={`/teams/${standing.teamId}`}>Make an invite code</Link> and send it to them.</>
        )}
      </p>
      <div className="mt-3"><Legend /></div>
      <div className="mt-4">
        {suggestions.isLoading || !standing ? <Skeleton /> : suggestions.error ? (
          <ErrorState error={suggestions.error} onRetry={() => void suggestions.refetch()} />
        ) : !suggestions.data?.suggestions.length ? (
          <EmptyState title="Nothing to suggest yet.">
            {forTeam ? (
              <>Add the skills your team is looking for with <Link className="text-accent underline underline-offset-4" to={`/teams/${standing!.teamId}`}>Edit team</Link>.</>
            ) : (
              <>Add skills to <Link className="text-accent underline underline-offset-4" to="/profile">your profile</Link>.</>
            )}
          </EmptyState>
        ) : (
          <ol className="flex flex-col gap-3">
            {suggestions.data.suggestions.map((s) => <SuggestionCard key={s.id} suggestion={s} isTeam={forTeam} />)}
          </ol>
        )}
      </div>
    </div>
  );
}
