import { createContext, useContext, useMemo, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { Link } from 'react-router-dom';
import { cx, StatusBadge, ToastRegion, useToasts, type BadgeTone } from '@fmc/knack-ui';
import { formatDayNum, formatMonthShort, formatWeekday, initials } from '../lib/format';

// ── Toasts (app-wide) ─────────────────────────────────────────────────────

const ToastCtx = createContext<(message: string, tone?: 'success' | 'error') => void>(() => undefined);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const { toasts, push, dismiss } = useToasts();
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
};
export const useToast = () => useContext(ToastCtx);

// ── Status ────────────────────────────────────────────────────────────────

const TONE_WORDS: Array<[BadgeTone, RegExp]> = [
  ['danger', /cancel|abnormal|critical|urgent|expired|denied|discontinu|overdue|fail|no.?show|rejected|high/i],
  ['success', /complete|active|normal|confirm|approved|done|filled|received|resolved|^read$|^yes$/i],
  ['warning', /pending|awaiting|review|hold|low|requested|refill|draft|medium/i],
  ['brand', /in progress|checked.?in|arrived/i],
  ['info', /schedul|new|booked|upcoming|sent|open|unread/i],
];

export const toneFor = (value: unknown): BadgeTone => {
  const s = typeof value === 'string' ? value : '';
  for (const [tone, re] of TONE_WORDS) if (re.test(s)) return tone;
  return 'neutral';
};

export const StatusPill = ({ value, className }: { value: unknown; className?: string }) =>
  typeof value === 'string' && value ? (
    <StatusBadge tone={toneFor(value)} className={className}>
      {value}
    </StatusBadge>
  ) : null;

// ── Avatar ────────────────────────────────────────────────────────────────

const AVATAR_TONES = [
  'bg-brand-100 text-brand-800',
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
  'bg-amber-100 text-amber-800',
  'bg-rose-100 text-rose-800',
  'bg-emerald-100 text-emerald-800',
];

export const Avatar = ({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) => {
  const tone = AVATAR_TONES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_TONES.length];
  const dims = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-12 w-12 text-base', xl: 'h-16 w-16 text-xl' }[size];
  return (
    <span aria-hidden="true" className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', dims, tone, className)}>
      {initials(name) || '•'}
    </span>
  );
};

// ── Layout bits ───────────────────────────────────────────────────────────

export const Page = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx('mx-auto w-full max-w-6xl space-y-6', className)}>{children}</div>
);

export const Section = ({
  title,
  action,
  children,
  className,
  description,
}: {
  title: ReactNode;
  action?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section className={cx('space-y-3', className)}>
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-steel-900">{title}</h2>
        {description && <p className="text-sm text-steel-500">{description}</p>}
      </div>
      {action}
    </div>
    {children}
  </section>
);

export const Panel = ({ children, className, as: As = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'ul' }) => (
  <As className={cx('overflow-hidden rounded-2xl border border-steel-200 bg-white shadow-sm', className)}>{children}</As>
);

export const TextLink = ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
  <Link
    to={to}
    className={cx(
      'inline-flex items-center gap-1 rounded text-sm font-medium text-brand-700 hover:text-brand-800 hover:underline',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
      className,
    )}
  >
    {children}
  </Link>
);

/** Calendar leaf: MON / 12 / NOV. */
export const DateTile = ({ value, muted, className }: { value: unknown; muted?: boolean; className?: string }) => (
  <div
    className={cx(
      'flex w-14 shrink-0 flex-col items-center justify-center rounded-xl border py-1.5 leading-tight',
      muted ? 'border-steel-200 bg-steel-50 text-steel-500' : 'border-brand-200 bg-brand-50 text-brand-800',
      className,
    )}
    aria-hidden="true"
  >
    <span className="text-[10px] font-semibold uppercase tracking-wide">{formatWeekday(value)}</span>
    <span className="text-xl font-bold">{formatDayNum(value)}</span>
    <span className="text-[10px] font-medium uppercase">{formatMonthShort(value)}</span>
  </div>
);

export const SkeletonRows = ({ rows = 3, className }: { rows?: number; className?: string }) => (
  <div className={cx('space-y-3', className)} aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex animate-pulse items-center gap-4 rounded-2xl border border-steel-100 bg-white p-4">
        <div className="h-12 w-12 rounded-xl bg-steel-100" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-1/3 rounded bg-steel-100" />
          <div className="h-3 w-1/2 rounded bg-steel-100" />
        </div>
      </div>
    ))}
  </div>
);

export const Empty = ({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="flex flex-col items-center rounded-2xl border border-dashed border-steel-200 bg-white px-6 py-10 text-center">
    {icon && <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-steel-100 text-steel-500">{icon}</div>}
    <p className="font-medium text-steel-900">{title}</p>
    {children && <p className="mt-1 max-w-sm text-sm text-steel-500">{children}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const InlineError = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => (
  <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
    <span>{(error as Error)?.message ?? 'Something went wrong.'}</span>
    {onRetry && (
      <button type="button" onClick={onRetry} className="font-medium underline hover:no-underline">
        Try again
      </button>
    )}
  </div>
);

// ── Rich text ─────────────────────────────────────────────────────────────

/**
 * Knack rich text is HTML. It is sanitised before rendering: no scripts, no
 * event handlers, no iframes, no styles; links open safely.
 */
export const SafeHtml = ({ html, className }: { html: unknown; className?: string }) => {
  const clean = useMemo(() => {
    if (typeof html !== 'string' || !html.trim()) return '';
    const out = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'hr'],
      ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'],
      ALLOWED_URI_REGEXP: /^(https?:|mailto:|tel:)/i,
    });
    return out;
  }, [html]);
  if (!clean) return null;
  return <div className={cx('prose-knack text-sm text-steel-700', className)} dangerouslySetInnerHTML={{ __html: clean }} />;
};

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Plain text a person typed -> safe paragraphs of HTML for a rich text field. */
export const textToHtml = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((para) =>
      `<p>${para
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '<br>')}</p>`,
    )
    .join('');

/** Rich text -> plain text for editing in a textarea. */
export const htmlToText = (html: unknown): string => {
  if (typeof html !== 'string' || !html) return '';
  const doc = new DOMParser().parseFromString(
    DOMPurify.sanitize(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')),
    'text/html',
  );
  return (doc.body.textContent ?? '').trim();
};

export const plainText = (html: unknown, max = 140): string => {
  const t = htmlToText(html).replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
