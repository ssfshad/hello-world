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
  style: z.enum(['beginner', 'story', 'cf']),
  include_struggles: z.boolean(),
  provider_id: z.string().nullable().optional(),
});

/** Mirror of backend §8.4 used for client-side preview hints. */
export const generatedProblemSchema = z.object({
  title: z.string().max(120),
  difficulty: z.number().int().min(1).max(5),
  concepts: z.array(z.string()),
  statement: z.string(),
  input_format: z.string(),
  output_format: z.string(),
  constraints: z.string().nullable().optional(),
  samples: z
    .array(z.object({ input: z.string(), output: z.string(), explanation: z.string().nullable().optional() }))
    .min(2),
  hint: z.string(),
  reference_solution: z.string(),
});
export const generatedSetSchema = z.object({ problems: z.array(generatedProblemSchema).min(1).max(10) });
