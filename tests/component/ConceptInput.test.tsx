import type { ReactElement } from 'react';
import { render as rtlRender, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConceptInput } from '@/components/domain/ConceptInput';
import { setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';
import type { Concept } from '@/core/types/api';
import { expectNoA11yViolations } from '../a11y';

// The example editor looks up the error journal, so it needs a query client.
const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  resetMock({ seeded: false });
  setInvoker(mockInvoke);
});
afterEach(() => setInvoker(null));

const concept = (name: string): Concept => ({
  id: name,
  language_id: 'py',
  name,
  category_id: null,
  category_name: 'Loops',
  note: null,
  example_code: null,
  example_output: null,
  source_resource_id: null,
  learned_day_key: '2026-09-20',
  review_stage: 0,
  due_day_key: null,
  created_at: '',
  updated_at: '',
});

const existing = [concept('for loops'), concept('while loops'), concept('f-strings')];
const search = (p: string) => existing.filter((c) => c.name.includes(p.toLowerCase()));

describe('Concept autocomplete', () => {
  it('suggests existing concepts and picks one with the keyboard', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onAdd = vi.fn();
    render(<ConceptInput search={search} categories={[]} onAdd={onAdd} onPickExisting={onPick} />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'loop');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'for loops' }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('blocks near-duplicates like "for-loop"', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<ConceptInput search={(p) => (p.startsWith('for') ? [existing[0]] : [])} categories={[]} onAdd={onAdd} />);
    await user.type(screen.getByRole('combobox'), 'for loop');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You already have “for loops”');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('opens the inline expander and saves note, example code, output and category', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const { container } = render(
      <ConceptInput search={() => []} categories={[{ id: 'cc-lists', name: 'Lists' }]} onAdd={onAdd} />,
    );
    await user.type(screen.getByRole('combobox'), 'list slicing{Enter}');
    await user.type(screen.getByLabelText('Note — in my words'), 'take a piece of a list');
    await user.click(screen.getByRole('button', { name: 'Write example' }));
    const editor = screen.getByRole('dialog', { name: 'Example: list slicing' });
    await user.type(within(editor).getByLabelText('Example code'), 'xs = [[1, 2, 3]{enter}print(xs[[1:])');
    await user.type(within(editor).getByLabelText('Output'), '[[2, 3]');
    await user.click(within(editor).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit example' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lists' }));
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onAdd).toHaveBeenCalledWith({
      name: 'list slicing',
      note: 'take a piece of a list',
      example_code: 'xs = [1, 2, 3]\nprint(xs[1:])',
      example_output: '[2, 3]',
      category_id: 'cc-lists',
      source_resource_id: null,
      source_url: null,
    });
  });
});
