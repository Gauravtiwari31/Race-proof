import * as RadixDialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, sendIntent, type BoardTeam } from '../api';
import { useHackathon, useStanding } from '../App';
import { Button, Dialog, Field, useToast } from './ui';

const itemClass =
  'flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm text-ink-soft data-[selected=true]:bg-raised data-[selected=true]:text-ink data-[selected=true]:shadow-[inset_2px_0_0_var(--color-accent)]';

export function CommandPalette({ open, onOpenChange, onJoinByCode, onLogout }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJoinByCode: () => void;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const hackathon = useHackathon().data;
  const standing = useStanding(hackathon?.id).data;

  const teams = useQuery({
    queryKey: ['palette-teams', hackathon?.id],
    queryFn: () => api<{ teams: BoardTeam[] }>(`/hackathons/${hackathon!.id}/board/teams?limit=50`),
    enabled: open && Boolean(hackathon),
  });

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  const toggleLooking = async () => {
    if (!hackathon) return;
    try {
      const next = !standing?.looking;
      await sendIntent(`/hackathons/${hackathon.id}/participation`, { method: 'PUT', body: { looking: next } });
      await client.invalidateQueries({ queryKey: ['standing'] });
      await client.invalidateQueries({ queryKey: ['board'] });
      toast(next ? 'You are on the board.' : 'You are off the board.');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/60"
      contentClassName="fixed top-[12dvh] left-1/2 z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-2xl shadow-black/60"
    >
      <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
      <Command.Input placeholder="Type a command or a recent team" className="min-h-12 w-full border-b border-line-soft bg-transparent px-4 text-base text-ink outline-none placeholder:text-ink-mute" />
      <Command.List className="max-h-[50dvh] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-ink-mute">Nothing matches.</Command.Empty>
        <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-mute [&_[cmdk-group-heading]]:uppercase">
          <Command.Item className={itemClass} onSelect={() => run(onJoinByCode)}>Join a team with a code</Command.Item>
          {standing?.teamId ? (
            <Command.Item className={itemClass} onSelect={() => run(() => navigate(`/teams/${standing.teamId}`))}>Go to my team</Command.Item>
          ) : (
            <Command.Item className={itemClass} onSelect={() => run(() => void toggleLooking())}>
              {standing?.looking ? 'Stop looking for a team' : 'Mark me as looking for a team'}
            </Command.Item>
          )}
          <Command.Item className={itemClass} onSelect={() => run(() => navigate('/'))}>Go to the board</Command.Item>
          <Command.Item className={itemClass} onSelect={() => run(() => navigate('/suggestions'))}>See suggestions</Command.Item>
          <Command.Item className={itemClass} onSelect={() => run(() => navigate('/arena'))}>Open the Race Arena</Command.Item>
          <Command.Item className={itemClass} onSelect={() => run(() => navigate('/ops'))}>Open the ops panel</Command.Item>
          <Command.Item className={itemClass} onSelect={() => run(() => navigate('/profile'))}>Edit my profile</Command.Item>
          <Command.Item className={itemClass} onSelect={() => run(onLogout)}>Sign out</Command.Item>
        </Command.Group>
        {Boolean(teams.data?.teams.length) && (
          <Command.Group heading="Recently active teams with open seats" className="mt-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-mute [&_[cmdk-group-heading]]:uppercase">
            {teams.data!.teams.map((team) => (
              <Command.Item key={team.id} value={`team ${team.name} ${team.id}`} className={itemClass} onSelect={() => run(() => navigate(`/teams/${team.id}`))}>
                <span className="truncate">{team.name}</span>
                <span className="ml-auto pl-3 font-mono text-xs text-ink-mute">{team.memberCount}/{team.maxSize}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

export function JoinByCodeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const join = useMutation({
    mutationFn: () => sendIntent<{ teamId: string }>('/invites/redeem', { method: 'POST', body: { code } }),
    onSuccess: async ({ teamId }) => {
      onOpenChange(false);
      setCode('');
      setError(null);
      await client.invalidateQueries();
      navigate(`/teams/${teamId}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    join.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Join a team with a code" description="Ask the team leader for an invite code.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Invite code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="TEAM-7KQ2-M9XD-H4" autoComplete="off" spellCheck={false} required error={error} className="font-mono" />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" tone="primary" busy={join.isPending}>Join team</Button>
        </div>
      </form>
    </Dialog>
  );
}
