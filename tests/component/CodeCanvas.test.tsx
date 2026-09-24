import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { CodeCanvas } from '@/components/ui';
import { expectNoA11yViolations } from '../a11y';

function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <CodeCanvas label="Example code" hint="Tab indents" value={v} onChange={setV} />
      <button type="button">next</button>
    </>
  );
}

describe('CodeCanvas', () => {
  it('is a labelled textarea that keeps indentation and has no a11y violations', async () => {
    const { container } = render(<Harness />);
    const area = screen.getByRole('textbox', { name: 'Example code' });
    await userEvent.type(area, 'for i in x:{enter}');
    await userEvent.tab();
    await userEvent.type(area, 'print(i)');
    expect(area).toHaveValue('for i in x:\n    print(i)');
    await expectNoA11yViolations(container);
  });

  it('Esc then Tab moves focus out instead of indenting', async () => {
    render(<Harness initial="x = 1" />);
    const area = screen.getByRole('textbox', { name: 'Example code' });
    area.focus();
    await userEvent.keyboard('{Escape}');
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'next' })).toHaveFocus();
    expect(area).toHaveValue('x = 1');
  });

  it('shows one line number per line', async () => {
    const { container } = render(<Harness initial={'a\nb\nc\nd\ne\nf\ng\nh'} />);
    const gutter = container.querySelector('[aria-hidden="true"]');
    expect(gutter?.textContent?.split('\n')).toHaveLength(8);
  });
});
