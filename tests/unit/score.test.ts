import { compare, usefulness } from '@/data/mock/score';
import { extractJson, validateResponse } from '@/data/mock/prompts';

describe('usefulness score v1 (backend §6)', () => {
  it('weights the components', () => {
    const full = usefulness({ focusedMinutes: 60, goalMinutes: 60, concepts: 2, solved: 3, attempted: 0, reflected: true });
    expect(full.score).toBe(100);
    const half = usefulness({ focusedMinutes: 30, goalMinutes: 60, concepts: 1, solved: 0, attempted: 0, reflected: false });
    expect(half.score).toBe(Math.round(35 * 0.5 + 20 * 0.5));
  });

  it('caps shadowing days at 60', () => {
    const s = usefulness({ focusedMinutes: 120, goalMinutes: 60, concepts: 2, solved: 0, attempted: 0, reflected: true });
    expect(s.score).toBe(60);
    expect(s.shadowing_capped).toBe(true);
  });

  it('compares self vs calculated', () => {
    const calc = usefulness({ focusedMinutes: 60, goalMinutes: 60, concepts: 2, solved: 1, attempted: 0, reflected: true });
    expect(compare(calc.score - 25, calc, 'x').tone).toBe('harder');
    expect(compare(calc.score, calc, 'x').tone).toBe('agree');
    expect(compare(Math.min(100, calc.score + 25), calc, 'x').tone).toBe('higher');
  });
});

describe('AI response validation (backend §8.5)', () => {
  const problem = {
    title: 'Echo',
    difficulty: 1,
    concepts: ['for loops'],
    statement: 's',
    input_format: 'i',
    output_format: 'o',
    samples: [
      { input: '1', output: '1' },
      { input: '2', output: '2' },
    ],
    hint: 'h',
    reference_solution: 'print(1)',
  };

  it('strips fences and surrounding text', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nEnjoy')).toBe('{"a":1}');
  });

  it('accepts valid sets and warns on semantic issues', () => {
    const ok = validateResponse(JSON.stringify({ problems: [problem] }), ['for loop'], 1);
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toEqual([]);
    const warn = validateResponse(
      JSON.stringify({ problems: [{ ...problem, difficulty: 3, concepts: ['recursion'] }] }),
      ['for loops'],
      1,
    );
    expect(warn.ok).toBe(true);
    expect(warn.warnings.length).toBe(2);
  });

  it('reports invalid JSON and every schema error', () => {
    expect(validateResponse('not json', [], 1).error_code).toBe('INVALID_JSON');
    const bad = validateResponse(JSON.stringify({ problems: [{ ...problem, samples: [], hint: undefined }] }), [], 1);
    expect(bad.error_code).toBe('SCHEMA');
    expect(bad.errors.length).toBeGreaterThanOrEqual(2);
  });
});
