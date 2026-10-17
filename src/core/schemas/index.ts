/** Zod schemas shared by forms and the data layer (frontend.md §8). */
import { z } from 'zod';

const optionalUrl = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\/\S+\.\S+/.test(v), { message: 'errors.url' });

export const problemStatusSchema = z.enum([
  'queued',
  'in_progress',
  'solved',
  'solved_with_help',
  'gave_up',
  'revisit',
]);

export const conceptNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'errors.required' })
  .max(60, { message: 'errors.conceptTooLong' });

export const conceptFormSchema = z.object({
  name: conceptNameSchema,
  note: z.string().max(2000).optional(),
  category_id: z.string().nullable().optional(),
  source_resource_id: z.string().nullable().optional(),
  source_url: optionalUrl.optional(),
});
export type ConceptForm = z.infer<typeof conceptFormSchema>;

export const problemFormSchema = z.object({
  title: z.string().trim().min(1, { message: 'errors.required' }).max(120, { message: 'errors.titleTooLong' }),
  url: optionalUrl,
  concept_ids: z.array(z.string()),
  difficulty: z.number().int().min(1).max(5).nullable(),
  status: problemStatusSchema,
  feeling_tag_id: z.string().nullable(),
  solution_text: z.string().max(100_000),
  solution_path: z.string().max(1000),
});
export type ProblemForm = z.infer<typeof problemFormSchema>;

export const diaryBodySchema = z.string().max(10_000, { message: 'errors.diaryTooLong' });

export const boundarySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'errors.boundary' });

export const onboardingSchema = z.object({
  display_name: z.string().trim().min(1, { message: 'errors.required' }).max(40),
  languages: z.array(z.string().trim().min(1)).min(1, { message: 'errors.pickLanguage' }),
  primary_language: z.string().min(1),
  daily_goal_min: z.number().int().min(5).max(720),
  day_boundary: boundarySchema,
  letter: z.string().max(10_000).nullable(),
});
export type OnboardingForm = z.infer<typeof onboardingSchema>;

export const profileSchema = z.object({
  display_name: z.string().trim().min(1, { message: 'errors.required' }).max(40),
  daily_goal_min: z.number().int().min(5).max(720),
  day_boundary: boundarySchema,
});
export type ProfileForm = z.infer<typeof profileSchema>;

export const linkSchema = z.object({
  url: z.string().trim().regex(/^https?:\/\/\S+\.\S+/, { message: 'errors.url' }),
  title: z.string().trim().max(200).optional(),
});

export const providerSchema = z.object({
  kind: z.enum(['ollama', 'openai_compatible', 'gemini', 'anthropic', 'openrouter']),
  label: z.string().trim().min(1, { message: 'errors.required' }).max(60),
  base_url: z.string().trim().max(300),
  model: z.string().trim().min(1, { message: 'errors.required' }).max(120),
  is_default: z.boolean(),
});
export type ProviderForm = z.infer<typeof providerSchema>;

export const practiceConfigSchema = z.object({
  language_id: z.string().min(1),
  concept_ids: z.array(z.string()).min(1),
  difficulty: z.number().int().min(1).max(5),
  count: z.number().int().min(1).max(10),
  style: z.enum(['beginner', 'story', 'cf', 'project']),
  include_struggles: z.boolean(),
  provider_id: z.string().nullable().optional(),
  custom_instructions: z.string().trim().max(500).nullable().optional(),
  types: z
    .array(z.enum(['write_code', 'predict_output', 'find_bug', 'fill_blank', 'multiple_choice']))
    .min(1)
    .optional(),
});

/** Mirror of backend §8.4 used for client-side preview hints. */
/** The ___ gap marker in fill_blank code. */
export const BLANK = '___';
const filled = (v: string | null | undefined) => !!v && v.trim().length > 0;

export const generatedProblemSchema = z
  .object({
    type: z.enum(['write_code', 'predict_output', 'find_bug', 'fill_blank', 'multiple_choice']).default('write_code'),
    title: z.string().max(120),
    difficulty: z.number().int().min(1).max(5),
    concepts: z.array(z.string()),
    statement: z.string(),
    input_format: z.string().optional(),
    output_format: z.string().optional(),
    constraints: z.string().nullable().optional(),
    samples: z
      .array(z.object({ input: z.string(), output: z.string(), explanation: z.string().nullable().optional() }))
      .optional(),
    hint: z.string().optional(),
    reference_solution: z.string().optional(),
    code: z.string().nullable().optional(),
    expected_output: z.string().nullable().optional(),
    blanks: z.array(z.string()).nullable().optional(),
    options: z.array(z.string()).max(6).nullable().optional(),
    correct_option: z.number().int().min(0).nullable().optional(),
    explanation: z.string().nullable().optional(),
  })
  // What each type must contain (mirrors the Rust checks).
  .superRefine((p, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (p.type === 'write_code') {
      need((p.samples?.length ?? 0) >= 2, 'samples', 'needs at least 2 samples');
      need(filled(p.hint), 'hint', 'needs a hint');
      need(filled(p.reference_solution), 'reference_solution', 'needs a reference solution');
    } else if (p.type === 'predict_output') {
      need(filled(p.code), 'code', 'needs code');
      need(filled(p.expected_output), 'expected_output', 'needs the expected output');
    } else if (p.type === 'find_bug') {
      need(filled(p.code), 'code', 'needs code');
      need(filled(p.reference_solution), 'reference_solution', 'needs the fixed code');
    } else if (p.type === 'fill_blank') {
      const gaps = (p.code ?? '').split(BLANK).length - 1;
      need(gaps > 0, 'code', 'needs ___ gaps in its code');
      need(gaps === 0 || (p.blanks?.length ?? 0) === gaps, 'blanks', `has ${gaps} gaps but ${p.blanks?.length ?? 0} answers`);
    } else {
      const n = p.options?.length ?? 0;
      need(n >= 2 && n <= 6, 'options', 'needs 2 to 6 options');
      need(p.correct_option != null && p.correct_option < n, 'correct_option', 'must point at one of the options');
    }
  });
export const generatedSetSchema = z.object({ problems: z.array(generatedProblemSchema).min(1).max(10) });
