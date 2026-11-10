import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Me } from '../api';
import { useMe } from '../App';
import { Button, Card, Field, Skeleton, useToast } from '../components/ui';

export const minutesToTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export const timeToMinutes = (time: string) => {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
};

const ZONES = Intl.supportedValuesOf('timeZone');

export function TimezoneField({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const id = useId();
  // The browser's own zone may be an alias missing from the list, such as Asia/Kolkata.
  const options = ZONES.includes(value) ? ZONES : [value, ...ZONES];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink-soft">Time zone</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="min-h-11 w-full rounded-md border border-line bg-bg px-3 text-base text-ink">
        {options.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
      </select>
    </div>
  );
}

export function AvailabilityFields({ start, end, onStart, onEnd }: {
  start: string;
  end: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Available from" type="time" required value={start} onChange={(e) => onStart(e.target.value)} />
      <Field label="Available until" type="time" required value={end} onChange={(e) => onEnd(e.target.value)} hint="Can run past midnight." />
    </div>
  );
}

function ProfileForm({ me }: { me: Me }) {
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: me.name,
    skills: me.skills.join(', '),
    primaryRole: me.primaryRole ?? '',
    timezone: me.timezone,
    start: minutesToTime(me.availStartMin),
    end: minutesToTime(me.availEndMin),
  });
  useEffect(() => setForm((f) => ({ ...f, name: me.name })), [me.name]);

  const save = useMutation({
    mutationFn: () =>
      api<Me>('/me', {
        method: 'PATCH',
        body: {
          name: form.name,
          skills: form.skills.split(',').map((s) => s.trim()).filter(Boolean),
          ...(form.primaryRole.trim() ? { primaryRole: form.primaryRole.trim() } : {}),
          timezone: form.timezone,
          availStartMin: timeToMinutes(form.start),
          availEndMin: timeToMinutes(form.end),
        },
      }),
    onSuccess: (updated) => {
      client.setQueryData(['me'], updated);
      void client.invalidateQueries({ queryKey: ['suggestions'] });
      toast('Profile saved.');
    },
    onError: (err) => toast(err.message, 'error'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Name" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <Field label="Skills" hint="Comma separated. These drive your suggestions." value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} />
      <Field label="Main role" value={form.primaryRole} onChange={(e) => setForm({ ...form, primaryRole: e.target.value })} />
      <TimezoneField value={form.timezone} onChange={(timezone) => setForm({ ...form, timezone })} />
      <AvailabilityFields start={form.start} end={form.end} onStart={(start) => setForm({ ...form, start })} onEnd={(end) => setForm({ ...form, end })} />
      <Button type="submit" tone="primary" busy={save.isPending} className="self-start">Save profile</Button>
    </form>
  );
}

export function Profile() {
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' });
    client.clear();
    navigate('/login');
  };
  return (
    <div className="mx-auto max-w-xl">
      <p className="eyebrow">Passenger details</p>
      <h1 className="display mt-2 mb-6 text-5xl">Your profile</h1>
      <Card>{me.data ? <ProfileForm me={me.data} /> : <Skeleton lines={2} />}</Card>
      <div className="mt-4 sm:hidden">
        <Button tone="ghost" onClick={() => void signOut()}>Sign out</Button>
      </div>
    </div>
  );
}
