/**
 * Practice setup against the seeded mock backend: the All time range,
 * Select all / none, the difficulty help next to its label, the friendly
 * empty prompt, and the setup being remembered between visits.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, queryClient } from '@/app/App';
import { setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';
import { DEFAULT_PRACTICE_SETTINGS, useUiStore } from '@/stores/uiStore';

const T = { timeout: 15000 };

describe('practice setup', () => {
  beforeEach(() => {
    queryClient.clear();
    useUiStore.setState({ practiceSettings: DEFAULT_PRACTICE_SETTINGS });
    resetMock({ seeded: true });
    setInvoker(mockInvoke);
  });
  afterEach(() => setInvoker(null));

  it('picks concepts from all time, selects none/all, and remembers the setup', async () => {
    window.location.hash = '#/practice';
    const user = userEvent.setup();
    const first = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Practice' }, T);

    // The help icon sits with the Difficulty label.
    const group = screen.getByRole('radiogroup', { name: 'Difficulty' });
    expect(group.previousElementSibling).toContainElement(
      screen.getByLabelText('What the difficulty levels mean'),
    );

    await user.click(screen.getByRole('button', { name: 'All time' }));
    expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
    const status = await screen.findByText(/\d+ of \d+ selected/, {}, T);
    const total = Number(status.textContent!.match(/of (\d+)/)![1]);
    expect(total).toBeGreaterThan(0);

    // With nothing picked the prompt box explains what to do instead.
    await user.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByText(`0 of ${total} selected`)).toBeInTheDocument();
    expect(screen.getByText(/Pick at least one concept/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText(`${total} of ${total} selected`)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /^4/ }));
    await user.selectOptions(screen.getByLabelText('How many'), '5');
    expect(useUiStore.getState().practiceSettings).toMatchObject({
      range: 'all',
      difficulty: 4,
      count: 5,
    });
    first.unmount();

    // Coming back keeps it.
    queryClient.clear();
    const again = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Practice' }, T);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByRole('radio', { name: /^4/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('How many')).toHaveValue('5');
    again.unmount();
  });

  it('offers All time when the range has no concepts', async () => {
    useUiStore.setState({ practiceSettings: { ...DEFAULT_PRACTICE_SETTINGS, range: 'custom', customFrom: '2000-01-01', customTo: '2000-01-02' } });
    window.location.hash = '#/practice';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Try All time' }, T));
    expect(await screen.findByText(/\d+ of \d+ selected/, {}, T)).toBeInTheDocument();
    expect(useUiStore.getState().practiceSettings.range).toBe('all');
    unmount();
  });
});
