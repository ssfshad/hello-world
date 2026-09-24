import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProblemModal } from '@/components/domain/ProblemModal';
import type { Concept, FeelingTag } from '@/core/types/api';
import { expectNoA11yViolations } from '../a11y';

const concepts = [{ id: 'c1', name: 'for loops' }] as Concept[];
const feelings: FeelingTag[] = [
  { id: 'ft-proud', name: 'Proud', valence: 1, is_builtin: true },
  { id: 'ft-stuck', name: 'Stuck', valence: -1, is_builtin: true },
];

describe('Log a problem modal', () => {
  it('validates the title inline instead of blocking', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ProblemModal open onClose={() => {}} concepts={concepts} feelings={feelings} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Save problem' }));
    expect(await screen.findByText("This can't be empty.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a malformed link', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ProblemModal open onClose={() => {}} concepts={concepts} feelings={feelings} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Title'), 'FizzBuzz');
    await user.type(screen.getByLabelText(/Link/), 'not a link');
    await user.click(screen.getByRole('button', { name: 'Save problem' }));
    expect(await screen.findByText(/doesn't look like a web link/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a complete problem', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { baseElement } = render(
      <ProblemModal open onClose={() => {}} concepts={concepts} feelings={feelings} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText('Title'), 'FizzBuzz');
    await user.click(screen.getByRole('button', { name: 'for loops' }));
    await user.click(screen.getByRole('radio', { name: /Easy/ }));
    await user.click(screen.getByRole('button', { name: 'Solved with help' }));
    await user.click(screen.getByRole('button', { name: 'Stuck' }));
    await expectNoA11yViolations(baseElement.querySelector('[role="dialog"]')!);
    await user.click(screen.getByRole('button', { name: 'Save problem' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: 'FizzBuzz',
      concept_ids: ['c1'],
      difficulty: 2,
      status: 'solved_with_help',
      feeling_tag_id: 'ft-stuck',
    });
  });
});
