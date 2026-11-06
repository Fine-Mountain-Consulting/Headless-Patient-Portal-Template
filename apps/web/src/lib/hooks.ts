import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

export const useDebounced = <T,>(value: T, ms: number): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

/** Sets the document title, so tabs and history say where you are. */
export const useTitle = (title: string | undefined, appName = 'Patient Portal') => {
  useEffect(() => {
    document.title = title ? `${title} · ${appName}` : appName;
  }, [title, appName]);
};

/** Move focus to the main region on route change (screen readers announce the new page). */
export const useFocusOnNavigate = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    const main = document.getElementById('main');
    if (main && document.activeElement !== main) main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [pathname]);
};
