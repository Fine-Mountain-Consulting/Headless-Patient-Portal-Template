/**
 * Session state, automatic logoff, and role selection.
 *
 * The session itself is an HttpOnly cookie the server owns; this only mirrors
 * who is signed in. Signing out (or being signed out) clears every cached
 * record from memory, so the next person at a shared computer sees nothing.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, onSessionEnded } from './api';

export interface RoleInfo {
  profileKey: string;
  name: string;
  slug: string;
  admin: boolean;
  recordId: string | null;
}

export interface Me {
  user: { accountId: string; name: string; email: string };
  roles: RoleInfo[];
  /** Changes when the Knack structure changes; the schema is refetched. */
  appVersion?: string;
  idleAt: number;
  maxAt: number;
}

export type EndReason = 'idle' | 'expired' | 'signed-out' | null;

interface SessionContext {
  me: Me | null;
  loading: boolean;
  endReason: EndReason;
  signIn: (email: string, password: string) => Promise<Me>;
  signOut: (reason?: EndReason) => Promise<void>;
  /** Seconds left before automatic sign-out, when the warning is showing. */
  warningSeconds: number | null;
  stayActive: () => void;
}

const Ctx = createContext<SessionContext | null>(null);

const WARN_BEFORE_MS = 60_000;
const PING_EVERY_MS = 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;

export const SessionProvider = ({ children }: { children: ReactNode }) => {
  const qc = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [endReason, setEndReason] = useState<EndReason>(null);
  const [warningSeconds, setWarningSeconds] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());
  const lastPing = useRef(Date.now());
  const pinging = useRef(false);

  const clearEverything = useCallback(() => {
    qc.clear();
    try {
      sessionStorage.clear();
    } catch {
      /* private mode */
    }
  }, [qc]);

  const end = useCallback(
    (reason: EndReason) => {
      clearEverything();
      setMe(null);
      setWarningSeconds(null);
      setEndReason(reason);
    },
    [clearEverything],
  );

  // Restore on load.
  useEffect(() => {
    api<Me | null>('/session')
      .then((m) => setMe(m))
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  // Any 401 anywhere ends the session here too.
  useEffect(() => onSessionEnded(() => end('expired')), [end]);

  const ping = useCallback(async () => {
    if (pinging.current) return;
    pinging.current = true;
    try {
      const m = await api<Me>('/session/ping', { method: 'POST' });
      lastPing.current = Date.now();
      // A role removed in Knack shows up here within a couple of minutes.
      // Drop everything cached under the old roles, schema included.
      setMe((prev) => {
        const key = (x: Me | null) => (x?.roles ?? []).map((r) => r.profileKey).sort().join(',');
        if (prev && key(prev) !== key(m)) qc.clear();
        // The Knack app changed (fields, pages, access): refetch what depends on it.
        else if (prev?.appVersion && m.appVersion && prev.appVersion !== m.appVersion) {
          void qc.invalidateQueries({ queryKey: ['schema'] });
          void qc.invalidateQueries({ queryKey: ['records'] });
          void qc.invalidateQueries({ queryKey: ['booking'] });
        }
        return m;
      });
      setWarningSeconds(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) end('expired');
    } finally {
      pinging.current = false;
    }
  }, [end, qc]);

  // Activity tracking and the idle clock.
  useEffect(() => {
    if (!me) return;
    const mark = () => {
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const timer = window.setInterval(() => {
      const now = Date.now();
      const deadline = Math.min(me.idleAt, me.maxAt);
      if (now >= deadline) {
        void api('/session/logout', { method: 'POST' }).catch(() => undefined);
        end('idle');
        return;
      }
      // Active since the last server contact: slide the server's window.
      if (lastActivity.current > lastPing.current && now - lastPing.current > PING_EVERY_MS && deadline - now > WARN_BEFORE_MS) {
        void ping();
        return;
      }
      if (deadline - now <= WARN_BEFORE_MS && me.idleAt <= me.maxAt) {
        setWarningSeconds(Math.max(0, Math.ceil((deadline - now) / 1000)));
      } else {
        setWarningSeconds(null);
      }
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, mark));
      window.clearInterval(timer);
    };
  }, [me, end, ping]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      clearEverything();
      const m = await api<Me>('/session/login', { method: 'POST', body: { email, password } });
      lastActivity.current = Date.now();
      lastPing.current = Date.now();
      setEndReason(null);
      setMe(m);
      return m;
    },
    [clearEverything],
  );

  const signOut = useCallback(
    async (reason: EndReason = 'signed-out') => {
      await api('/session/logout', { method: 'POST' }).catch(() => undefined);
      end(reason);
    },
    [end],
  );

  const value = useMemo<SessionContext>(
    () => ({ me, loading, endReason, signIn, signOut, warningSeconds, stayActive: () => void ping() }),
    [me, loading, endReason, signIn, signOut, warningSeconds, ping],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useSession = (): SessionContext => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
};
