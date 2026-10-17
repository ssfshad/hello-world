/**
 * Notebook lessons against the mock backend: the shelf (welcome, courses,
 * creating a lesson), a saved page opening in the editor, linking "What I
 * learned" concepts, search, and the Days tab still being there.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, queryClient } from '@/app/App';
import { setInvoker } from '@/data/client';
import { mockInvoke, resetMock } from '@/data/mock';
import type { Concept, Lesson } from '@/core/types/api';
import { expectNoA11yViolations } from '../a11y';

const T = { timeout: 15000 };

describe('notebook lessons', () => {
  beforeEach(() => {
    queryClient.clear();
    resetMock({ seeded: true });
    setInvoker(mockInvoke);
  });
  afterEach(() => setInvoker(null));

  it('welcomes a first lesson, creates one and opens it', async () => {
    window.location.hash = '#/notebook';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Your own notebook for every lesson' }, T);
    expect(screen.getByRole('tab', { name: 'Lessons' })).toHaveAttribute('aria-selected', 'true');
    await expectNoA11yViolations(document.getElementById('main')!);

    await user.click(screen.getByRole('button', { name: 'Start your first lesson' }));
    const dialog = await screen.findByRole('dialog', { name: /New lesson/ });
    // A title is required.
    await user.click(within(dialog).getByRole('button', { name: 'Create lesson' }));
    expect(await within(dialog).findByText('Give the lesson a title')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Lesson title'), 'Dictionaries');
    await user.type(within(dialog).getByLabelText('Course'), 'Python Bootcamp');
    await user.click(within(dialog).getByRole('button', { name: '🐍' }));
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Create lesson' }));

    await waitFor(() => expect(window.location.hash).toMatch(/^#\/notebook\/lessons\//), T);
    expect(await screen.findByRole('textbox', { name: 'Lesson title' }, T)).toHaveValue(
      'Dictionaries',
    );
    expect(screen.getByRole('tab', { name: /Page/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('toolbar', { name: 'Formatting' }, T)).toBeInTheDocument();

    const lessons = (await mockInvoke('lesson_list', {})) as Lesson[];
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      title: 'Dictionaries',
      course: 'Python Bootcamp',
      icon: '🐍',
    });
    unmount();
  });

  it('shelves lessons by course and opens a saved page', async () => {
    const make = async (title: string, course: string | null, day: string) =>
      (await mockInvoke('lesson_create', { input: { title, course, day_key: day } })) as Lesson;
    const first = await make('Variables', 'Python Bootcamp', '2026-09-20');
    await make('Loops', 'Python Bootcamp', '2026-09-22');
    await make('How the web works', null, '2026-09-21');
    const page = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Boxes with names' }],
        },
        {
          type: 'callout',
          attrs: { kind: 'tip' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'A variable points to a value' }],
            },
          ],
        },
      ],
    };
    await mockInvoke('lesson_update', {
      input: {
        id: first.id,
        page: JSON.stringify(page),
        page_text: 'Boxes with names\nA variable points to a value',
      },
    });

    window.location.hash = '#/notebook';
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const course = await screen.findByRole('region', { name: 'Python Bootcamp' }, T);
    const cards = within(course).getAllByRole('button');
    // Learning order inside a course.
    expect(cards[0]).toHaveTextContent('Lesson 1');
    expect(cards[0]).toHaveTextContent('Variables');
    expect(cards[0]).toHaveTextContent('A variable points to a value');
    expect(cards[1]).toHaveTextContent('Loops');
    expect(screen.getByRole('region', { name: 'Other lessons' })).toHaveTextContent(
      'How the web works',
    );

    // Searching narrows the shelf.
    await user.type(screen.getByRole('searchbox'), 'variable');
    await waitFor(() => expect(screen.queryByText('Loops')).not.toBeInTheDocument());

    await user.click(
      within(screen.getByRole('region', { name: 'Python Bootcamp' })).getByRole('button', {
        name: /Variables/,
      }),
    );
    const editor = await screen.findByRole('textbox', { name: 'Lesson page' }, T);
    await waitFor(() =>
      expect(within(editor).getByRole('heading', { name: 'Boxes with names' })).toBeInTheDocument(),
    );
    expect(editor.querySelector('[data-callout="tip"]')).toHaveTextContent(
      'A variable points to a value',
    );
    unmount();
  });

  it('links what I learned and finds lessons in search', async () => {
    const lesson = (await mockInvoke('lesson_create', {
      input: { title: 'Lists', course: 'Python Bootcamp' },
    })) as Lesson;
    await mockInvoke('lesson_update', {
      input: { id: lesson.id, page_text: 'append adds to the end of a list' },
    });
    const concepts = (await mockInvoke('concept_list', {})) as Concept[];
    const existing = concepts[0];

    window.location.hash = `#/notebook/lessons/${lesson.id}`;
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const row = await screen.findByRole('region', { name: 'What I learned' }, T);
    expect(within(row).getByText('Nothing linked yet.')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'What did you learn in this lesson?',
    });
    await user.type(within(dialog).getByRole('combobox'), existing.name.slice(0, 3));
    await user.click(
      await within(dialog).findByRole('option', { name: new RegExp(existing.name) }),
    );
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: existing.name })).toBeInTheDocument(),
    );
    await waitFor(async () => {
      const saved = (await mockInvoke('lesson_get', { id: lesson.id })) as Lesson;
      expect(saved.concept_ids).toEqual([existing.id]);
    }, T);
    // Unlinking only removes it from the lesson.
    await user.click(
      within(row).getByRole('button', { name: `Remove ${existing.name} from this lesson` }),
    );
    await waitFor(async () => {
      const saved = (await mockInvoke('lesson_get', { id: lesson.id })) as Lesson;
      expect(saved.concept_ids).toEqual([]);
    }, T);
    unmount();

    const hits = (await mockInvoke('search', { query: 'append', filters: {} })) as {
      kind: string;
      ref_id: string;
    }[];
    expect(hits).toContainEqual(expect.objectContaining({ kind: 'lesson', ref_id: lesson.id }));
  });

  it('keeps the day calendar in the Days tab', async () => {
    window.location.hash = '#/notebook?tab=days';
    const { unmount } = render(<App />);
    expect(await screen.findByRole('grid', {}, T)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Days' })).toHaveAttribute('aria-selected', 'true');
    unmount();
  });

  it('rejects files that are not pictures and bad page data', async () => {
    const lesson = (await mockInvoke('lesson_create', { input: { title: 'Pics' } })) as Lesson;
    await expect(
      mockInvoke('lesson_asset_add', { lesson_id: lesson.id, data_base64: 'aGVsbG8=', ext: 'exe' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      mockInvoke('lesson_update', { input: { id: lesson.id, page: '[1]' } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const a = await mockInvoke('lesson_asset_add', {
      lesson_id: lesson.id,
      data_base64: 'iVBORw0KGgo=',
      ext: 'png',
    });
    expect(a).toMatchObject({ lesson_id: lesson.id, mime: 'image/png' });
    expect(await mockInvoke('lesson_asset_data', { id: (a as { id: string }).id })).toMatch(
      /^data:image\/png;base64,/,
    );
  });
});
