import type { ReactElement } from 'react';
import { render as rtlRender, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ConceptInput } from '@/components/domain/ConceptInput';
import { call, setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';
import type { Concept } from '@/core/types/api';
import { expectNoA11yViolations } from '../a11y';

// The example editor looks up the error journal and the notebook picker lists
// lessons, so it needs a query client; "Open lesson" needs a router.
const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

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

describe('Put it in your notebook (while adding)', () => {
  /** a real concept in the mock backend, as the page's onAdd would return */
  const addReal = async (name: string) => {
    const lang = await call('language_add', { name: 'Python' });
    return call('concept_add', {
      input: {
        language_id: lang.id,
        name,
        note: null,
        example_code: null,
        example_output: null,
        category_id: null,
        source_resource_id: null,
        day_key: '2026-10-18',
      },
    });
  };

  it('starts a new lesson named after the concept, linked to it', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(() => addReal('list slicing'));
    render(<ConceptInput search={() => []} categories={[]} onAdd={onAdd} linkToNotebook />);
    await user.type(screen.getByRole('combobox'), 'list slicing{Enter}');
    expect(screen.getByRole('button', { name: 'Not now' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'New lesson' }));
    await user.type(screen.getByLabelText(/Course/), 'CS50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const lessons = await call('lesson_list', { query: null });
    expect(lessons).toHaveLength(1);
    const created = await onAdd.mock.results[0].value;
    expect(lessons[0]).toMatchObject({ title: 'list slicing', course: 'CS50', concept_ids: [created.id] });
  });

  it('adds the concept to a lesson you already have', async () => {
    const user = userEvent.setup();
    const old = await call('lesson_create', {
      input: { title: 'Week 1', course: null, icon: null, color: null, language_id: null, concept_ids: [] },
    });
    const onAdd = vi.fn(() => addReal('f-strings'));
    render(<ConceptInput search={() => []} categories={[]} onAdd={onAdd} linkToNotebook />);
    await user.type(screen.getByRole('combobox'), 'f-strings{Enter}');
    await user.click(await screen.findByRole('button', { name: 'A lesson I already have' }));
    expect(screen.getByLabelText('Lesson')).toHaveDisplayValue(/Week 1/);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const created = await onAdd.mock.results[0].value;
    const [lesson] = await call('lesson_list', { query: null });
    expect(lesson).toMatchObject({ id: old.id, concept_ids: [created.id] });
  });

  it('leaves the notebook alone by default', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(() => addReal('loops'));
    render(<ConceptInput search={() => []} categories={[]} onAdd={onAdd} linkToNotebook />);
    await user.type(screen.getByRole('combobox'), 'loops{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onAdd).toHaveBeenCalled();
    expect(await call('lesson_list', { query: null })).toHaveLength(0);
  });
});
