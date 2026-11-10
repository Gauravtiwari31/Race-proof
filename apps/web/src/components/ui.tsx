import * as RadixDialog from '@radix-ui/react-dialog';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import type { LiveState } from '../live';
import { ApiError, type MemberPreview } from '../api';

type Tone = 'primary' | 'secondary' | 'danger' | 'ghost';

const TONES: Record<Tone, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hi font-semibold',
  secondary: 'bg-raised text-ink border border-line hover:bg-line-soft',
  danger: 'bg-transparent text-danger border border-danger/70 hover:bg-danger/10',
  ghost: 'bg-transparent text-ink-soft hover:bg-raised hover:text-ink',
};

/** Also for links that act as buttons, so both look and size the same. */
export const buttonClass = (tone: Tone = 'secondary', className = '') =>
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${TONES[tone]} ${className}`;

export function Button({
  tone = 'secondary',
  className = '',
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={buttonClass(tone, className)}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | null }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...props}
        className={`min-h-11 w-full rounded-md border border-line bg-bg px-3 text-base text-ink transition-colors placeholder:text-ink-mute hover:border-ink-mute focus-visible:border-accent ${props.className ?? ''}`}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-ink-mute">
          {hint}
        </p>
      )}
      {/* Mounts only with an error, so each new one is announced. */}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({ children, className = '', flush = false }: { children: ReactNode; className?: string; flush?: boolean }) {
  return <section className={`rounded-xl border border-line-soft bg-surface ${flush ? '' : 'p-4 sm:p-5'} ${className}`}>{children}</section>;
}

export function Tag({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 font-mono text-xs whitespace-nowrap ${
        highlight ? 'border-accent/70 bg-accent/10 text-accent' : 'border-line-soft text-ink-soft'
      }`}
    >
      {children}
    </span>
  );
}

export function Tags({ items, highlight = [] }: { items: string[]; highlight?: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item}>
          <Tag highlight={highlight.includes(item)}>{item}</Tag>
        </li>
      ))}
    </ul>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/** Seats as physical slots, so a change is visible at a glance and capacity needs no reading. */
export function SeatSlots({ members, memberCount, maxSize, size = 'md' }: {
  members: MemberPreview[] | null;
  memberCount: number;
  maxSize: number;
  size?: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'h-8 w-7 text-[10px]' : 'h-12 w-11 text-sm';
  const gap = size === 'sm' ? 'gap-x-3 gap-y-2' : 'gap-x-4 gap-y-3';
  const seats = Array.from({ length: Math.max(maxSize, memberCount) }, (_, i) => members?.[i] ?? (i < memberCount ? 'taken' : null));
  return (
    <ul className={`flex flex-wrap px-1.5 ${gap}`} aria-label={`${memberCount} of ${maxSize} seats taken`}>
      {seats.map((seat, i) => (
        <li key={seat && seat !== 'taken' ? seat.userId : `seat-${i}`} aria-hidden="true">
          {seat === null ? (
            <span className={`seat seat-empty ${box}`}>{SEAT_LETTERS[i] ?? ''}</span>
          ) : seat === 'taken' ? (
            <span className={`seat seat-in bg-raised text-ink-soft ${box}`} />
          ) : (
            <span
              title={seat.optimistic ? `${seat.name}, confirming` : seat.role === 'leader' ? `${seat.name}, leader` : seat.name}
              className={`seat seat-in ${box} ${
                seat.optimistic
                  ? 'seat-hold border-[1.5px] border-dashed border-accent bg-accent/10 text-accent'
                  : seat.role === 'leader'
                    ? 'bg-accent text-on-accent'
                    : 'bg-ink-soft text-bg'
              }`}
            >
              {initials(seat.name)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const SEAT_LETTERS = 'ABCDEFGHJK';

/**
 * A number on split-flap tiles. It turns over when the value changes, like a departures board, so a
 * live update is seen, not just rendered. Screen readers get the plain label instead.
 */
export function Flap({ value, digits = 2, label, mute, flip, className = '' }: { value: number | string; digits?: number; label: string; mute?: boolean; flip?: boolean; className?: string }) {
  const chars = String(value).padStart(digits, '0').split('');
  const previous = useRef(String(value));
  const turned = Boolean(flip) || previous.current !== String(value);
  useEffect(() => {
    previous.current = String(value);
  }, [value]);
  return (
    <span role="img" aria-label={label} className={`inline-flex gap-0.5 ${className}`}>
      {chars.map((c, i) => (
        <span key={`${i}-${turned ? c : 'still'}`} aria-hidden="true" className={`flap ${turned ? 'flap-turn' : ''} ${mute ? 'flap-mute' : ''}`}>
          <span>{c}</span>
        </span>
      ))}
    </span>
  );
}

export function LiveBadge({ state }: { state: LiveState }) {
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.14em] text-ink-mute uppercase">
      <span aria-hidden="true" className="relative flex h-2 w-2">
        {state === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-live opacity-60 motion-reduce:hidden" />}
        <span className={`relative h-2 w-2 rounded-full ${state === 'live' ? 'bg-live' : 'bg-warn'}`} />
      </span>
      {label}
    </span>
  );
}

/** Asks before anything that cannot be undone. The destructive button is never the default. */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button tone="danger" busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px]" />
        <RadixDialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className="rise fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-2xl shadow-black/60"
        >
          <RadixDialog.Title className="display text-2xl">{title}</RadixDialog.Title>
          {description && <RadixDialog.Description className="mt-1 text-sm text-ink-mute">{description}</RadixDialog.Description>}
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 5000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div role="status" aria-live="assertive" className="pointer-events-none fixed inset-x-4 bottom-20 z-50 flex flex-col items-center gap-2 sm:bottom-6">
        {toasts.map((t) => (
          <p
            key={t.id}
            className={`rise pointer-events-auto max-w-md rounded-md border px-4 py-3 text-sm shadow-lg ${
              t.tone === 'error' ? 'border-danger/70 bg-surface text-danger' : 'border-accent/50 bg-raised text-ink'
            }`}
          >
            {t.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line p-8 text-center">
      <p className="display text-xl text-ink-soft">{title}</p>
      {children && <div className="mt-2 text-sm text-ink-mute">{children}</div>}
    </div>
  );
}

/** A failed load says so and offers a retry, so an outage never reads as an empty list. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-danger/50 p-6 text-center">
      <p className="display text-xl text-danger">Could not load this.</p>
      <p className="mt-2 text-sm text-ink-mute">{error instanceof ApiError ? error.message : 'Could not reach the server.'}</p>
      <Button className="mt-4" onClick={onRetry}>Retry</Button>
    </div>
  );
}

/** `inset` is for inside a Card, where the page-level surface colour would not show. */
export function Skeleton({ lines = 3, inset = false }: { lines?: number; inset?: boolean }) {
  return (
    <div aria-hidden="true" className={`flex flex-col gap-3 ${inset ? 'mt-3' : ''}`}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`animate-pulse ${inset ? 'h-10 rounded-md bg-raised' : 'h-20 rounded-xl bg-surface'}`} />
      ))}
    </div>
  );
}

/** The wordmark: a seat, and the one word the product is about. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <img src="/favicon.svg" alt="" className="h-7 w-7" />
      <span className={`display text-[22px] tracking-[0.04em] ${compact ? 'hidden min-[480px]:inline' : ''}`}>
        Last<span className="text-accent">seat</span>
      </span>
    </span>
  );
}
