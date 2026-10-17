/**
 * Practice setup against the seeded mock backend: the All time range,
 * Select all / none, the difficulty help next to its label, the friendly
 * empty prompt, and the setup being remembered between visits.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, queryClient } from '@/app/App';
import { setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';
import { TYPE_EXAMPLES } from '@/data/mock/prompts';
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

  it('puts extra instructions in their own prompt section', async () => {
    useUiStore.setState({ practiceSettings: { ...DEFAULT_PRACTICE_SETTINGS, range: 'all' } });
    window.location.hash = '#/practice';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const box = await screen.findByLabelText('Extra instructions for the AI (optional)', {}, T);
    await screen.findByText(/\d+ of \d+ selected/, {}, T);
    const preview = () => document.querySelector('pre[aria-busy]')?.textContent ?? '';
    await waitFor(() => expect(preview()).toContain('OUTPUT'), T);
    expect(preview()).not.toContain('EXTRA INSTRUCTIONS');

    await user.type(box, 'use food examples');
    expect(screen.getByText(/17\/500/)).toBeInTheDocument();
    await waitFor(
      () =>
        expect(preview()).toContain(
          "LEARNER'S EXTRA INSTRUCTIONS (follow unless they break the rules above):\nuse food examples",
        ),
      T,
    );
    expect(useUiStore.getState().practiceSettings.instructions).toBe('use food examples');
    unmount();
  });

  it('mixes problem types and shows each one in the queue and details', async () => {
    useUiStore.setState({ practiceSettings: { ...DEFAULT_PRACTICE_SETTINGS, range: 'all' } });
    window.location.hash = '#/practice';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await screen.findByText(/\d+ of \d+ selected/, {}, T);
    const types = screen.getByRole('group', { name: 'Problem types' });
    const writeCode = within(types).getByRole('button', { name: 'Write the code' });
    expect(writeCode).toHaveAttribute('aria-pressed', 'true');
    // The last picked type can't be switched off.
    await user.click(writeCode);
    expect(writeCode).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(types).getByRole('button', { name: 'Multiple choice' }));
    expect(useUiStore.getState().practiceSettings.types).toEqual(['write_code', 'multiple_choice']);
    const preview = () => document.querySelector('pre[aria-busy]')?.textContent ?? '';
    await waitFor(() => expect(preview()).toContain('Use these types: write_code, multiple_choice.'), T);

    // Import a mixed set the way "Paste AI response" does.
    const cfg = {
      language_id: (await mockInvoke('app_state', {}) as { languages: { id: string; is_primary: boolean }[] }).languages.find((l) => l.is_primary)!.id,
      concept_ids: [((await mockInvoke('concept_list', {})) as { id: string }[])[0].id],
      difficulty: 1,
      count: 2,
      style: 'beginner',
      include_struggles: false,
      types: ['write_code', 'multiple_choice'],
    };
    const mc = { ...TYPE_EXAMPLES.multiple_choice, title: 'Length of hello' };
    await mockInvoke('practice_import_response', {
      input: { config: cfg, raw_text: JSON.stringify({ problems: [TYPE_EXAMPLES.write_code, mc] }), mode: 'copy_prompt' },
    });
    unmount();
    queryClient.clear();

    const again = render(<App />);
    const row = (await screen.findByRole('button', { name: 'Length of hello' }, T)).closest('li')!;
    expect(row).toHaveTextContent('Multiple choice');
    await user.selectOptions(screen.getByLabelText('Type'), 'multiple_choice');
    expect(screen.queryByRole('button', { name: 'Short title' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Length of hello' }));
    const dialog = await screen.findByRole('dialog', { name: 'Length of hello' }, T);
    expect(within(dialog).getByText('What does len("hello") return?')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['4', '5', '6', 'an error']);
    await user.click(within(dialog).getByRole('button', { name: "I'm done — show answer" }));
    expect(await within(dialog).findByText('"hello" has 5 characters.', {}, T)).toBeInTheDocument();
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
