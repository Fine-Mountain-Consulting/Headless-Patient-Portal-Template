import { Fragment, type ComponentType, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Menu, MenuButton, MenuItem, MenuItems, Transition } from '@headlessui/react';
import { ArrowRightStartOnRectangleIcon, ArrowsRightLeftIcon, ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';
import { AppShell, cx, type NavSection } from '@fmc/knack-ui';
import { useSession } from '../lib/session';
import { experiencesFor, rememberExperience, type Experience } from '../lib/experiences';
import { Avatar } from './ui';
import { IdleWarning } from './IdleWarning';

export interface ShellNavItem {
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  /** Shown in the phone tab bar. Keep it to four. */
  tab?: boolean;
  /** Exact match for the active state (home routes). */
  end?: boolean;
}

export const Brand = ({ appName }: { appName: string }) => (
  <span className="flex items-center gap-2.5">
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm" aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
        <path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z" />
      </svg>
    </span>
    <span className="truncate text-[15px] font-semibold tracking-tight text-steel-900">{appName}</span>
  </span>
);

export const Shell = ({
  experience,
  appName,
  sections,
  children,
}: {
  experience: Experience;
  appName: string;
  sections: Array<{ label?: string; items: ShellNavItem[] }>;
  children: ReactNode;
}) => {
  const location = useLocation();
  const all = sections.flatMap((s) => s.items);
  const isActive = (to: string) => {
    const item = all.find((i) => i.to === to);
    return item?.end ? location.pathname === to : location.pathname === to || location.pathname.startsWith(`${to}/`);
  };
  const tabs = all.filter((i) => i.tab);

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow">
        Skip to content
      </a>
      <AppShell
        brand={<Brand appName={appName} />}
        sections={sections as NavSection[]}
        isActive={isActive}
        renderLink={({ to, className, children: c, onNavigate }) => (
          <Link to={to} className={className} onClick={onNavigate} aria-current={isActive(to) ? 'page' : undefined}>
            {c}
          </Link>
        )}
        userMenu={<UserMenu experience={experience} />}
      >
        <main id="main" className={cx('focus:outline-none', tabs.length > 0 && 'pb-safe lg:pb-0')} tabIndex={-1}>
          {children}
        </main>
      </AppShell>
      {tabs.length > 0 && (
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-steel-200 bg-white/95 backdrop-blur lg:hidden"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <ul className="mx-auto flex max-w-md">
            {tabs.map((t) => (
              <li key={t.to} className="flex-1">
                <NavLink
                  to={t.to}
                  end={t.end}
                  className={({ isActive: a }) =>
                    cx(
                      'flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                      a ? 'text-brand-700' : 'text-steel-500 hover:text-steel-800',
                    )
                  }
                >
                  <t.icon className="h-6 w-6" />
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <IdleWarning />
    </>
  );
};

const UserMenu = ({ experience }: { experience: Experience }) => {
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  if (!me) return null;
  const others = experiencesFor(me.roles);
  return (
    <Menu as="div" className="relative ml-auto">
      <MenuButton className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-sm hover:bg-steel-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <Avatar name={me.user.name} size="sm" />
        <span className="hidden max-w-[12rem] truncate font-medium text-steel-800 sm:block">{me.user.name}</span>
        <ChevronDownIcon className="h-4 w-4 text-steel-400" aria-hidden="true" />
      </MenuButton>
      <Transition as={Fragment} enter="transition ease-out duration-100" enterFrom="opacity-0 scale-95" enterTo="opacity-100 scale-100" leave="transition ease-in duration-75" leaveFrom="opacity-100 scale-100" leaveTo="opacity-0 scale-95">
        <MenuItems className="absolute right-0 z-40 mt-2 w-64 origin-top-right rounded-xl border border-steel-200 bg-white p-1.5 shadow-lg focus:outline-none">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-semibold text-steel-900">{me.user.name}</p>
            <p className="truncate text-xs text-steel-500">{me.user.email}</p>
          </div>
          {others.length > 1 && (
            <div className="border-t border-steel-100 py-1">
              <p className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-steel-400">
                <ArrowsRightLeftIcon className="h-3.5 w-3.5" /> Switch view
              </p>
              {others.map((x) => (
                <MenuItem key={x.base}>
                  <button
                    type="button"
                    onClick={() => {
                      rememberExperience(x.base);
                      navigate(x.base);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-steel-700 data-[focus]:bg-steel-100"
                  >
                    {x.role.name}
                    {x.base === experience.base && <CheckIcon className="h-4 w-4 text-brand-600" />}
                  </button>
                </MenuItem>
              ))}
            </div>
          )}
          <div className="border-t border-steel-100 pt-1">
            <MenuItem>
              <button
                type="button"
                onClick={() => void signOut('signed-out').then(() => navigate('/signin'))}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-steel-700 data-[focus]:bg-steel-100"
              >
                <ArrowRightStartOnRectangleIcon className="h-4 w-4" /> Sign out
              </button>
            </MenuItem>
          </div>
        </MenuItems>
      </Transition>
    </Menu>
  );
};
