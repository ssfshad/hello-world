/**
 * Prompt templates (backend §8.6) and response validation (§8.5). The Rust core
 * owns these for real; this mirror powers the browser mock and client tests.
 */
import type { GeneratedProblem, ImportPreview } from '@/core/types/api';
import { generatedSetSchema } from '@/core/schemas';

export const PROMPT_VERSION = 1;

export const DIFFICULTY_DEFS: Record<number, string> = {
  1: 'Uses exactly one concept directly. 3–10 lines of code.',
  2: 'One or two concepts, straightforward input, no edge-case traps.',
  3: 'Two or three concepts together; one small edge case.',
  4: 'Needs a small insight or careful edge-case handling; still only known concepts.',
  5: 'Codeforces Div. 3 A/B flavor: short story, precise I/O format, multiple test cases, constraints.',
};

export const STYLE_DEFS: Record<string, string> = {
  beginner: 'Beginner-clear: plain wording, one idea per sentence, no story.',
  story: 'Story-based: a short, friendly real-world scenario around the task.',
  cf: 'Codeforces-style: short story, precise input/output format, multiple test cases, explicit constraints.',
  project:
    'Mini project: a small, useful program a beginner can finish in under an hour. Say what to build and list 3-5 small steps; samples show example runs.',
};

export const JSON_SHAPE_EXAMPLE = `{
  "problems": [
    {
      "title": "string (max 120 chars)",
      "difficulty": 1,
      "concepts": ["concept name from the list"],
      "statement": "string",
      "input_format": "string",
      "output_format": "string",
      "constraints": "string (optional)",
      "samples": [
        { "input": "string", "output": "string", "explanation": "string (optional)" },
        { "input": "string", "output": "string" }
      ],
      "hint": "string",
      "reference_solution": "string"
    }
  ]
}`;

export interface PromptVars {
  language: string;
  journey_day: number;
  concepts: { name: string; note: string | null }[];
  count: number;
  difficulty: number;
  style: string;
  struggles: string[];
}

export function buildGeneratePrompt(v: PromptVars): string {
  const list = v.concepts.map((c) => `- ${c.name}${c.note ? `: ${c.note}` : ''}`).join('\n');
  const struggles = v.struggles.length
    ? `Recent struggles (include at least one gentle problem on these ideas):\n${v.struggles.map((s) => `- ${s}`).join('\n')}\n`
    : '';
  return `You are a patient programming coach for a beginner learning ${v.language}.
They are on day ${v.journey_day} of learning.

CONCEPTS THEY KNOW (use only these, plus basic syntax such as variables,
print, input, if/else, arithmetic):
${list}

DO NOT require any concept, library or technique not listed above.

TASK
Create ${v.count} practice problems at difficulty ${v.difficulty}/5.
Difficulty ${v.difficulty} means: ${DIFFICULTY_DEFS[v.difficulty]}
Style: ${STYLE_DEFS[v.style] ?? v.style}
${struggles}
RULES
- Each problem practices at least one listed concept.
- Write clear, unambiguous statements. Define exact input and output formats.
- Give at least 2 samples. Before answering, mentally run your reference
  solution on every sample and make sure the outputs match exactly.
- The hint nudges without giving the answer away.
- reference_solution is complete, runnable ${v.language} code using only the
  listed concepts.

OUTPUT
Return ONLY valid JSON matching this shape, with no markdown and no extra text:
${JSON_SHAPE_EXAMPLE}
`;
}

export interface HintVars {
  language: string;
  journey_day: number;
  title: string;
  link: string | null;
  statement: string;
  attempt: string | null;
  concepts: string[];
}

/** Mirrors prompts/problem_hint.v1.txt: hints only, never the solution. */
export function buildHintPrompt(v: HintVars): string {
  const known = v.concepts.length
    ? v.concepts.map((c) => `- ${c}`).join('\n')
    : '- (none logged yet: assume only the very basics)';
  return `You are a patient programming coach for a beginner learning ${v.language}.
They are on day ${v.journey_day} of learning and are stuck on a problem.
They asked for HINTS ONLY. They want to solve it themselves.

PROBLEM
${v.title}
${v.link ? `Link: ${v.link}\n` : ''}${v.statement ? `${v.statement}\n` : ''}
${v.attempt ? `THEIR CODE SO FAR\n${v.attempt}\n\n` : ''}CONCEPTS THEY KNOW (explain using only these, plus basic syntax):
${known}

RULES
- Do NOT write the solution, and do NOT write corrected code.
- Give 3 hints, numbered, from a gentle nudge to a more specific one. Tell
  them to read one hint at a time and try again before reading the next.
- If their code has a bug, point to where to look and ask a question that
  helps them spot it. Don't fix it for them.
- Suggest one small thing to print or test to check their thinking.
- Use short sentences and a kind, encouraging tone.
`;
}

export function buildFixupPrompt(raw: string, errors: string[]): string {
  return `The text below was supposed to be JSON matching this schema but is invalid.
Return ONLY the corrected JSON. Do not change the content of the problems.
Errors: ${errors.length ? errors.join('; ') : 'could not parse as JSON'}
Schema: ${JSON_SHAPE_EXAMPLE}
Text:
${raw}`;
}

/** Strip markdown fences and anything outside the outermost {…}. */
export function extractJson(raw: string): string {
  let t = raw.trim().replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[()]/g, '').replace(/[-_\s]+/g, ' ').replace(/s\b/g, '').trim();
}

export function validateResponse(
  raw: string,
  selectedConcepts: string[],
  difficulty: number,
): ImportPreview {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch (e) {
    return {
      ok: false,
      error_code: 'INVALID_JSON',
      problems: [],
      errors: [`Not valid JSON: ${(e as Error).message}`],
      warnings: [],
    };
  }
  const parsed = generatedSetSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      error_code: 'SCHEMA',
      problems: [],
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      warnings: [],
    };
  }
  const problems = parsed.data.problems as GeneratedProblem[];
  const warnings: string[] = [];
  const known = selectedConcepts.map(norm);
  const titles = new Set<string>();
  problems.forEach((p, i) => {
    const n = i + 1;
    for (const c of p.concepts) {
      if (!known.some((k) => k === norm(c) || k.includes(norm(c)) || norm(c).includes(k))) {
        warnings.push(`Problem ${n} uses “${c}”, which isn't in your selected concepts.`);
      }
    }
    if (p.difficulty !== difficulty) {
      warnings.push(`Problem ${n} is level ${p.difficulty}, you asked for ${difficulty}.`);
    }
    if (p.samples.some((s) => !s.input.trim() && !s.output.trim())) {
      warnings.push(`Problem ${n} has an empty sample.`);
    }
    const key = p.title.trim().toLowerCase();
    if (titles.has(key)) warnings.push(`Two problems are titled “${p.title}”.`);
    titles.add(key);
  });
  return { ok: true, error_code: null, problems, errors: [], warnings };
}

export const LLM_PREAMBLE = `# Context for the AI reading this report

You are acting as a coding coach for a beginner. This report was exported from
a learning journal app. It lists what they learned, what they practiced, how
long it took, and how they felt.

How to help:
1. Generate practice problems ONLY from the concepts listed under
   "Concepts learned". Do not introduce new concepts.
2. Match the requested difficulty using the scale at the end of this report.
3. Prefer concepts marked "felt stuck" or "not practiced since".
4. Be encouraging. Beginners often feel like they are failing; point to
   evidence of progress in this report.
5. When asked for problems, answer in the JSON format described at the end
   so the user can paste it back into the app.
`;
