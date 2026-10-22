/**
 * Settings → Sync against the mock backend: the form validates the address,
 * turning sync on shows the status, "Sync now" reports back, turning it off
 * returns to the form. The real work is covered by the Rust tests.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, queryClient } from '@/app/App';
import { setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';
import { expectNoA11yViolations } from '../a11y';

const T = { timeout: 15000 };

describe('settings → sync', () => {
  beforeEach(() => {
    queryClient.clear();
    resetMock({ seeded: true });
    setInvoker(mockInvoke);
    window.location.hash = '#/settings';
  });
  afterEach(() => setInvoker(null));

  it('turns sync on, syncs, and turns it off', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const card = (await screen.findByRole('heading', { name: 'Sync' }, T)).closest('section')!;
    expect(card).toBeInTheDocument();

    const turnOn = screen.getByRole('button', { name: 'Turn on sync' });
    expect(turnOn).toBeDisabled();

    await user.type(screen.getByLabelText('Repo address'), 'https://github.com/me/hw-sync');
    await user.type(screen.getByLabelText('Access token'), 'github_pat_example');
    expect(screen.getByLabelText('Access token')).toHaveAttribute('type', 'password');
    await expectNoA11yViolations(card);
    await user.click(turnOn);

    expect(await screen.findByText('Sync is on', undefined, T)).toBeInTheDocument();
    expect(screen.getByText('https://github.com/me/hw-sync')).toBeInTheDocument();
    expect(screen.getByText(/Not yet/)).toBeInTheDocument();
    // The token is cleared from the form once stored.
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Synced. Nothing new from your other PCs.', undefined, T)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Not yet/)).not.toBeInTheDocument(), T);

    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('button', { name: 'Turn on sync' }, T)).toBeInTheDocument();
    unmount();
  });

  it('rejects an address that is not on github.com', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Sync' }, T);
    await user.type(screen.getByLabelText('Repo address'), 'https://example.com/me/repo');
    await user.type(screen.getByLabelText('Access token'), 'x');
    await user.click(screen.getByRole('button', { name: 'Turn on sync' }));
    expect(await screen.findByText(/https:\/\/github\.com\/<owner>\/<repo>/, undefined, T)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on sync' })).toBeInTheDocument();
    unmount();
  });
});
