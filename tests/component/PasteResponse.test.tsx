import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasteResponseModal } from '@/components/domain/PasteResponseModal';
import { validateResponse, buildFixupPrompt } from '@/data/mock/prompts';
import type { PracticeConfig } from '@/core/types/api';
import { expectNoA11yViolations } from '../a11y';

const config: PracticeConfig = {
  language_id: 'py',
  concept_ids: ['c1'],
  difficulty: 1,
  count: 1,
  style: 'beginner',
  include_struggles: false,
};

const valid = JSON.stringify({
  problems: [
    {
      title: 'Count up',
      difficulty: 1,
      concepts: ['for loops'],
      statement: 'Print 1..n',
      input_format: 'n',
      output_format: 'lines',
      samples: [
        { input: '2', output: '1\n2' },
        { input: '1', output: '1' },
      ],
      hint: 'range',
      reference_solution: 'for i in range(1, int(input())+1): print(i)',
    },
  ],
});

function setup(onImport = vi.fn().mockResolvedValue(undefined)) {
  const validate = vi.fn(async (raw: string) => validateResponse(raw, ['for loops'], 1));
  const fixup = vi.fn(async (raw: string) => buildFixupPrompt(raw, []));
  const utils = render(
    <PasteResponseModal open onClose={() => {}} config={config} validate={validate} fixupPrompt={fixup} onImport={onImport} />,
  );
  return { ...utils, validate, fixup, onImport };
}

describe('Paste AI response flow', () => {
  it('shows a friendly error and a fix-up prompt for invalid JSON', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { fixup } = setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Here are your problems: {oops' } });
    await user.click(screen.getByRole('button', { name: 'Check response' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't read that as problems");
    await user.click(screen.getByRole('button', { name: 'Copy fix-up prompt' }));
    await waitFor(() => expect(fixup).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Return ONLY the corrected JSON'));
  });

  it('validates → previews → adds', async () => {
    const user = userEvent.setup();
    const { onImport, baseElement } = setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '```json\n' + valid + '\n```' } });
    await user.click(screen.getByRole('button', { name: 'Check response' }));
    expect(await screen.findByText('1 problems ready')).toBeInTheDocument();
    expect(screen.getByText('Count up')).toBeInTheDocument();
    await expectNoA11yViolations(baseElement.querySelector('[role="dialog"]')!);
    await user.click(screen.getByRole('button', { name: 'Add to practice queue' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(expect.stringContaining('Count up')));
  });
});
