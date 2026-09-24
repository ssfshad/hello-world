/**
 * Smoke test: every screen renders against the seeded mock backend without
 * crashing, and the Today flow works end to end.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, queryClient } from '@/app/App';
import { setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';

async function renderAt(hash: string) {
  window.location.hash = hash;
  const utils = render(<App />);
  return utils;
}

describe('screens (mock backend)', () => {
  beforeEach(() => {
    queryClient.clear();
    resetMock({ seeded: true });
    setInvoker(mockInvoke);
  });
  afterEach(() => setInvoker(null));

  it.each([
    ['#/today', 'Today'],
    ['#/dashboard', 'Dashboard'],
    ['#/notebook', 'Notebook'],
    ['#/practice', 'Practice'],
    ['#/insights', 'Insights'],
    ['#/library', 'Library'],
    ['#/roadmaps', 'Roadmaps'],
    ['#/settings', 'Settings'],
  ])('renders %s', async (hash, title) => {
    const { unmount } = await renderAt(hash);
    expect(await screen.findByRole('heading', { level: 1, name: title }, { timeout: 15000 })).toBeInTheDocument();
    unmount();
  });

  it('redirects to onboarding on a fresh install and completes it', async () => {
    resetMock({ seeded: false });
    const user = userEvent.setup();
    const { unmount } = await renderAt('#/today');
    expect(await screen.findByRole('heading', { name: 'What should we call you?' })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Your name'), 'Rafi');
    await user.click(screen.getByRole('button', { name: 'Python' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Start my journey' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Today' }, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText(/Day 1 of your journey/)).toBeInTheDocument();
    unmount();
  });

  it('logs a concept on Today', async () => {
    resetMock({ seeded: false });
    await mockInvoke('onboarding_complete', {
      input: { display_name: 'Rafi', languages: ['Python'], primary_language: 'Python', daily_goal_min: 60, day_boundary: '04:00', letter: null },
    });
    const user = userEvent.setup();
    const { unmount } = await renderAt('#/today');
    const box = await screen.findByRole('combobox', {}, { timeout: 15000 });
    await user.type(box, 'variables{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const learned = screen.getByRole('heading', { name: 'What I learned' }).closest('section')!;
    await waitFor(() => expect(within(learned).getByText('variables')).toBeInTheDocument());
    unmount();
  });
});
