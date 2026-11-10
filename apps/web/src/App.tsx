import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, type Hackathon, type Me, type Standing } from './api';
import { Button, ErrorState, Skeleton, Wordmark } from './components/ui';
import { CommandPalette, JoinByCodeDialog } from './components/palette';
import { Arena } from './pages/Arena';
import { Login, Signup } from './pages/Auth';
import { Board } from './pages/Board';
import { Ops } from './pages/Ops';
import { Profile } from './pages/Profile';
import { Suggestions } from './pages/Suggestions';
import { TeamPage } from './pages/Team';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

/** This deployment runs one hackathon at a time, so the first listed is the current one. */
export function useHackathon() {
  return useQuery({
    queryKey: ['hackathon'],
    queryFn: async () => (await api<{ hackathons: Hackathon[] }>('/hackathons')).hackathons[0] ?? null,
  });
}

export function useStanding(hackathonId: string | undefined) {
  return useQuery({
    queryKey: ['standing', hackathonId],
    queryFn: () => api<Standing>(`/hackathons/${hackathonId}/me`),
    enabled: Boolean(hackathonId),
  });
}

const NAV = [
  { to: '/', label: 'Board', end: true, icon: 'M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z' },
  { to: '/suggestions', label: 'Suggestions', end: false, icon: 'M12 3l2.5 5.5L20 9.5l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1z' },
  { to: '/arena', label: 'Arena', end: false, icon: 'M13 2 4 14h7l-1 8 9-12h-7z' },
  { to: '/ops', label: 'Ops', end: false, icon: 'M3 12h4l2-7 4 14 2-7h6' },
];

const TITLES: Record<string, string> = {
  '/': 'Board',
  '/suggestions': 'Suggestions',
  '/arena': 'Race Arena',
  '/ops': 'Ops',
  '/profile': 'Profile',
  '/login': 'Sign in',
  '/signup': 'Sign up',
};
const routeTitle = (pathname: string) => TITLES[pathname] ?? 'Team';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `relative flex min-h-11 items-center gap-2 px-3 font-display text-[15px] font-semibold tracking-[0.06em] uppercase transition-colors ${
    isActive ? 'text-ink after:absolute after:inset-x-3 after:-bottom-[9px] after:h-[2px] after:bg-accent' : 'text-ink-mute hover:text-ink'
  }`;

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
      <path d={d} />
    </svg>
  );
}

function Shell({ children, me }: { children: ReactNode; me: Me }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    client.clear();
    navigate('/login');
  };

  return (
    <div className="flex min-h-dvh flex-col pb-16 sm:pb-0">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line-soft bg-bg/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
          <Link to="/" aria-label="Lastseat, go to the board" className="mr-3 flex min-h-11 shrink-0 items-center">
            <Wordmark compact />
          </Link>
          <nav aria-label="Main" className="hidden gap-1 sm:flex">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button tone="ghost" onClick={() => setPaletteOpen(true)} aria-label="Open command palette, Ctrl K" aria-keyshortcuts="Control+K Meta+K">
              <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5" />
              <kbd className="hidden rounded border border-line-soft px-1.5 py-0.5 font-mono text-[11px] text-ink-mute md:inline">Ctrl K</kbd>
            </Button>
            <NavLink to="/profile" className={navClass}>
              <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-raised font-mono text-[11px] text-ink-soft normal-case tracking-normal">{me.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}</span>
              <span className="sr-only max-w-32 truncate md:not-sr-only">{me.name}</span>
            </NavLink>
            <span className="hidden sm:inline">
              <Button tone="ghost" onClick={logout}>
                Sign out
              </Button>
            </span>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} aria-label={routeTitle(pathname)} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:py-8">
        {children}
      </main>

      {/* Primary destinations stay in thumb reach on a phone. */}
      <nav aria-label="Main, mobile" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line-soft bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 font-display text-[12px] font-semibold tracking-[0.08em] uppercase ${isActive ? 'text-accent' : 'text-ink-mute'}`}
          >
            <Icon d={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onJoinByCode={() => setJoinOpen(true)} onLogout={logout} />
      <JoinByCodeDialog open={joinOpen} onOpenChange={setJoinOpen} />
    </div>
  );
}

function Private({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isLoading) return <div className="mx-auto max-w-3xl p-6"><Skeleton /></div>;
  // useMe maps a 401 to null, so only a real sign-out redirects; an outage gets a retry instead.
  if (me.isError && me.data === undefined) return <div className="mx-auto max-w-3xl p-6"><ErrorState error={me.error} onRetry={() => void me.refetch()} /></div>;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Shell me={me.data}>{children}</Shell>;
}

/**
 * Moves focus and the title on navigation, which a client-side router otherwise never does. Focus
 * goes to the page heading when it has rendered, so a screen reader hears which page this is.
 */
function RouteFocus() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = `${routeTitle(pathname)} · Lastseat`;
    (document.querySelector<HTMLElement>('main h1[tabindex="-1"]') ?? document.getElementById('main'))?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <>
      <RouteFocus />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/" element={<Private><Board /></Private>} />
        <Route path="/suggestions" element={<Private><Suggestions /></Private>} />
        <Route path="/teams/:id" element={<Private><TeamPage /></Private>} />
        <Route path="/arena" element={<Private><Arena /></Private>} />
        <Route path="/ops" element={<Private><Ops /></Private>} />
        <Route path="/profile" element={<Private><Profile /></Private>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
