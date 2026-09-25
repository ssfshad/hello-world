/**
 * The learning tools end to end against the mock backend: getting-started
 * guide, Knowledge page (concepts, errors, glossary), recall review and the
 * "you've seen this error before" helper in the example editor.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, queryClient } from '@/app/App';
import { ExampleEditor } from '@/components/domain/ExampleEditor';
import { setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';
import { useUiStore } from '@/stores/uiStore';
import { expectNoA11yViolations } from '../a11y';

const T = { timeout: 15000 };

async function onboardFresh() {
  resetMock({ seeded: false });
  await mockInvoke('onboarding_complete', {
    input: {
      display_name: 'Rafi',
      languages: ['Python'],
      primary_language: 'Python',
      daily_goal_min: 60,
      day_boundary: '04:00',
      letter: null,
    },
  });
}

describe('learning tools', () => {
  beforeEach(() => {
    queryClient.clear();
    resetMock({ seeded: true });
    setInvoker(mockInvoke);
    useUiStore.setState({ guideHidden: false, welcomeDismissed: null, weekCardDismissed: null });
  });
  afterEach(() => setInvoker(null));

  it('guides a new learner and ticks steps off from real data', async () => {
    await onboardFresh();
    window.location.hash = '#/today';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const guide = (await screen.findByRole('heading', { name: 'Getting started' }, T)).closest(
      'section',
    )!;
    expect(within(guide).getByText('0 of 6 done')).toBeInTheDocument();
    await expectNoA11yViolations(guide);
    // "Add it" lands in the concept box.
    await user.click(within(guide).getByRole('button', { name: 'Add it' }));
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus());
    await user.type(screen.getByRole('combobox'), 'variables{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(guide).getByText('1 of 6 done')).toBeInTheDocument());
    // Hiding it keeps it hidden.
    await user.click(within(guide).getByRole('button', { name: 'Hide guide' }));
    expect(screen.queryByRole('heading', { name: 'Getting started' })).not.toBeInTheDocument();
    unmount();
  });

  it('shows concepts as a cheat sheet and runs a recall review', async () => {
    window.location.hash = '#/knowledge';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Knowledge' }, T);
    const start = await screen.findByRole('button', { name: /^Review \d+ due$/ }, T);
    await expectNoA11yViolations(document.getElementById('main')!);
    await user.click(start);
    const dialog = await screen.findByRole('dialog', { name: 'Review' });
    expect(within(dialog).getByText(/^1 of \d+$/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Show my note/ }));
    expect(within(dialog).getByText('Your note')).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole('button', { name: /Got it/ }));
    await waitFor(() => expect(within(dialog).getByText(/^2 of \d+$/)).toBeInTheDocument());
    unmount();
  });

  it('lists fixed errors and the built-in glossary', async () => {
    window.location.hash = '#/knowledge?tab=errors';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    expect(
      await screen.findByText('IndexError: list index out of range', {}, T),
    ).toBeInTheDocument();
    expect(screen.getByText('Seen 2 times')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Glossary' }));
    expect(await screen.findByText('parameter')).toBeInTheDocument();
    await expectNoA11yViolations(document.getElementById('main')!);
    unmount();
  });

  it('shows a week in review and saves the three answers', async () => {
    window.location.hash = '#/week';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Weekly review' }, T);
    const prev = screen.getByRole('button', { name: 'Previous week' });
    await user.click(prev);
    await user.click(prev);
    const focus = await screen.findByLabelText('One focus for next week', {}, T);
    await expectNoA11yViolations(document.getElementById('main')!);
    await user.type(focus, 'dictionaries');
    await user.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
    unmount();
  });
});

describe('error helper in the example editor', () => {
  beforeEach(() => {
    resetMock({ seeded: true });
    setInvoker(mockInvoke);
  });
  afterEach(() => setInvoker(null));

  const renderEditor = (output: string) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExampleEditor
          open
          onClose={() => {}}
          name="lists"
          code="xs = [1]"
          output={output}
          onCodeChange={() => {}}
          onOutputChange={() => {}}
        />
      </QueryClientProvider>,
    );

  it('shows the fix for an error seen before', async () => {
    renderEditor(
      'Traceback (most recent call last):\n  File "main.py", line 2\nIndexError: list index out of range',
    );
    expect(await screen.findByText("You've seen this error before")).toBeInTheDocument();
    expect(screen.getByText(/Loop over the items directly/)).toBeInTheDocument();
    await expectNoA11yViolations(screen.getByRole('dialog'));
  });

  it('offers to log a new error, and stays quiet for normal output', async () => {
    const { unmount } = renderEditor('ZeroDivisionError: division by zero');
    expect(await screen.findByRole('button', { name: 'Log this error' })).toBeInTheDocument();
    unmount();
    renderEditor('0\n1\n2');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/looks like an error/)).not.toBeInTheDocument();
  });
});
