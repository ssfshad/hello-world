import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MoodScale } from '@/components/ui';
import { expectNoA11yViolations } from '../a11y';

function Harness({ onChange }: { onChange: (v: number) => void }) {
  const [v, setV] = useState<number | null>(null);
  return (
    <MoodScale
      value={v}
      onChange={(n) => {
        setV(n);
        onChange(n);
      }}
    />
  );
}

describe('MoodScale', () => {
  it('is a radiogroup with five labelled options', async () => {
    const { container } = render(<Harness onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'How are you feeling?' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
    expect(radios[0]).toHaveAccessibleName('1 Drained');
    expect(radios[4]).toHaveAccessibleName('5 Fired up');
    await expectNoA11yViolations(container);
  });

  it('selects by click and by arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /Okay/ }));
    expect(onChange).toHaveBeenLastCalledWith(3);
    expect(screen.getByRole('radio', { name: /Okay/ })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith(4);
    expect(screen.getByRole('radio', { name: /Good/ })).toHaveFocus();
  });
});
