import { lazy, Suspense, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
import { Layout } from './Layout';
import { RequireOnboarding, StartRedirect } from './guards';
import { PageLoading } from './PageLoading';
import { ToastHost } from '@/components/ui';
import { toAppError } from '@/data/client';
import { toast } from '@/components/ui';
import i18n from '@/i18n';

const Today = lazy(() => import('@/pages/today/TodayPage'));
const Dashboard = lazy(() => import('@/pages/dashboard/DashboardPage'));
const Knowledge = lazy(() => import('@/pages/knowledge/KnowledgePage'));
const Week = lazy(() => import('@/pages/week/WeekPage'));
const Notebook = lazy(() => import('@/pages/notebook/NotebookPage'));
const Practice = lazy(() => import('@/pages/practice/PracticePage'));
const Insights = lazy(() => import('@/pages/insights/InsightsPage'));
const Library = lazy(() => import('@/pages/library/LibraryPage'));
const Roadmaps = lazy(() => import('@/pages/roadmaps/RoadmapsPage'));
const Settings = lazy(() => import('@/pages/settings/SettingsPage'));
const Onboarding = lazy(() => import('@/pages/onboarding/OnboardingPage'));

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
    mutations: {
      onError: (e) => {
        const err = toAppError(e);
        if (err.code === 'CANCELLED') return;
        toast.error(i18n.t('errors.generic', { message: err.message }));
      },
    },
  },
});

const s = (el: React.ReactNode) => <Suspense fallback={<PageLoading />}>{el}</Suspense>;

const routes = [
  { path: '/onboarding', element: s(<Onboarding />) },
  {
    element: (
      <RequireOnboarding>
        <Layout />
      </RequireOnboarding>
    ),
    children: [
      { index: true, element: <StartRedirect /> },
      { path: 'today', element: s(<Today />) },
      { path: 'dashboard', element: s(<Dashboard />) },
      { path: 'knowledge', element: s(<Knowledge />) },
      { path: 'week', element: s(<Week />) },
      { path: 'notebook', element: s(<Notebook />) },
      { path: 'notebook/:day', element: s(<Notebook />) },
      { path: 'practice', element: s(<Practice />) },
      { path: 'insights', element: s(<Insights />) },
      { path: 'library', element: s(<Library />) },
      { path: 'roadmaps', element: s(<Roadmaps />) },
      { path: 'roadmaps/:id', element: s(<Roadmaps />) },
      { path: 'settings', element: s(<Settings />) },
      { path: '*', element: <Navigate to="/today" replace /> },
    ],
  },
];

export function App() {
  const [router] = useState(() => createHashRouter(routes));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ToastHost />
    </QueryClientProvider>
  );
}
