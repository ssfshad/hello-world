import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  BookOpen,
  Code2,
  Dumbbell,
  HardDrive,
  Library,
  Lightbulb,
  Map,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
} from 'lucide-react';
import { useTimerStore } from '@/stores/timerStore';
import { useUiStore } from '@/stores/uiStore';
import { IconButton, Timer } from '@/components/ui';
import { useGlobalShortcuts } from './shortcuts';
import { QuickLog } from './QuickLog';
import { useBackgroundTasks } from './background';
import s from './layout.module.css';

export const NAV = [
  { to: '/today', key: 'today', icon: Sun },
  { to: '/dashboard', key: 'dashboard', icon: BarChart3 },
  { to: '/notebook', key: 'notebook', icon: BookOpen },
  { to: '/practice', key: 'practice', icon: Dumbbell },
  { to: '/insights', key: 'insights', icon: Lightbulb },
  { to: '/library', key: 'library', icon: Library },
  { to: '/roadmaps', key: 'roadmaps', icon: Map },
] as const;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1200);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1200);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return narrow;
}

export function Layout() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const pref = useUiStore((st) => st.sidebarCollapsed);
  const setPref = useUiStore((st) => st.setSidebarCollapsed);
  const setLastPage = useUiStore((st) => st.setLastPage);
  const collapsed = pref ?? narrow;
  const session = useTimerStore((st) => st.session);

  useGlobalShortcuts();
  useBackgroundTasks();

  useEffect(() => {
    setLastPage(location.pathname);
  }, [location.pathname, setLastPage]);

  const onToday = location.pathname.startsWith('/today');
  const running = !!session && !session.ended_at;

  return (
    <div className={[s.shell, collapsed && s.shellCollapsed].filter(Boolean).join(' ')}>
      <a href="#main" className={s.skip}>
        {t('app.skipToContent')}
      </a>
      <nav className={s.sidebar} aria-label="Main">
        <div className={s.brand}>
          <span className={s.brandMark} aria-hidden="true">
            <Code2 size={18} />
          </span>
          <span className={s.brandText}>
            {t('app.name')}
            <span className={s.brandTagline}>{t('app.tagline')}</span>
          </span>
        </div>
        <ul className={s.nav}>
          {NAV.map((n, i) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                className={s.link}
                title={collapsed ? t(`nav.${n.key}`) : undefined}
                aria-label={collapsed ? t(`nav.${n.key}`) : undefined}
              >
                <n.icon size={19} aria-hidden="true" />
                <span className={s.label}>{t(`nav.${n.key}`)}</span>
                <span className={s.kbd} aria-hidden="true">
                  {i + 1}
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className={s.bottom}>
          {running && !onToday && (
            <button
              type="button"
              className={[s.pill, session.paused_at && s.pillPaused].filter(Boolean).join(' ')}
              onClick={() => navigate('/today')}
              aria-label={t(session.paused_at ? 'nav.timerPaused' : 'nav.timerRunning')}
            >
              <span className={s.pillDot} aria-hidden="true" />
              <span className={s.pillTime}>
                <Timer timer={session} small />
              </span>
            </button>
          )}
          <NavLink
            to="/settings"
            className={s.link}
            aria-label={collapsed ? t('nav.settings') : undefined}
            title={collapsed ? t('nav.settings') : undefined}
          >
            <Settings size={19} aria-hidden="true" />
            <span className={s.label}>{t('nav.settings')}</span>
          </NavLink>
          <div className={s.local}>
            <HardDrive size={16} aria-hidden="true" style={{ flex: 'none' }} />
            <span className={s.localText}>{t('app.localOnly')}</span>
          </div>
          <div className={s.signature}>{t('app.signature')}</div>
          <IconButton
            className={s.collapseBtn}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            onClick={() => setPref(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </IconButton>
        </div>
      </nav>
      <main id="main" className={s.main} tabIndex={-1}>
        <div className={s.content}>
          <Outlet />
        </div>
      </main>
      <QuickLog />
    </div>
  );
}
