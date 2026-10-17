/**
 * Practice problem types in the client mirror of the import checks and prompt
 * (backend §8.4–8.6): each type needs its own fields, problems saved before
 * types existed still pass as "write the code", and the prompt only describes
 * the types that were picked.
 */
import { buildGeneratePrompt, TYPE_EXAMPLES, validateResponse } from '@/data/mock/prompts';
import type { GeneratedProblem, ProblemType } from '@/core/types/api';

/** A copy of a problem with one field left out. */
const without = (p: Partial<GeneratedProblem>, key: keyof GeneratedProblem) => {
  const copy = { ...p };
  delete copy[key];
  return copy;
};

const check = (p: Partial<GeneratedProblem>, types: ProblemType[] = []) =>
  validateResponse(JSON.stringify({ problems: [p] }), [], 1, types);

describe('problem types', () => {
  it('accepts the example of every type', () => {
    for (const ex of Object.values(TYPE_EXAMPLES)) {
      const r = check(ex);
      expect(r.ok, `${ex.type}: ${r.errors.join('; ')}`).toBe(true);
    }
  });

  it('rejects a type that is missing its own fields', () => {
    expect(check(without(TYPE_EXAMPLES.predict_output, 'expected_output')).ok).toBe(false);
    expect(check({ ...TYPE_EXAMPLES.fill_blank, blanks: ['0'] }).errors.join()).toMatch(/2 gaps but 1/);
    expect(check({ ...TYPE_EXAMPLES.multiple_choice, correct_option: 7 }).ok).toBe(false);
    expect(check({ ...TYPE_EXAMPLES.find_bug, reference_solution: '' }).ok).toBe(false);
    expect(check({ ...TYPE_EXAMPLES.write_code, type: 'essay' as ProblemType }).ok).toBe(false);
  });

  it('treats problems without a type as "write the code"', () => {
    const old = without(TYPE_EXAMPLES.write_code, 'type');
    const r = check(old);
    expect(r.ok).toBe(true);
    expect(r.problems[0].type).toBe('write_code');
    expect(check(without(old, 'samples')).ok).toBe(false);
  });

  it('warns about types that were not asked for', () => {
    const r = check(TYPE_EXAMPLES.multiple_choice, ['write_code']);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/multiple_choice/);
  });

  it('describes only the picked types in the prompt', () => {
    const v = {
      language: 'Python',
      journey_day: 3,
      concepts: [{ name: 'for loops', note: null }],
      count: 2,
      difficulty: 1,
      style: 'beginner',
      struggles: [],
    };
    const one = buildGeneratePrompt(v);
    expect(one).toContain('Use these types: write_code.');
    expect(one).not.toContain('Mix these types');
    const mixed = buildGeneratePrompt({ ...v, types: ['predict_output', 'fill_blank'] });
    expect(mixed).toContain('Use these types: predict_output, fill_blank. Mix these types across the set.');
    expect(mixed).toContain('"expected_output"');
    expect(mixed).toContain('"blanks"');
    expect(mixed).not.toContain('"input_format"');
  });
});
