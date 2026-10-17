/**
 * Prompt templates (backend §8.6) and response validation (§8.5). The Rust core
 * owns these for real; this mirror powers the browser mock and client tests.
 */
import type { GeneratedProblem, ImportPreview, ProblemType } from '@/core/types/api';
import { generatedSetSchema } from '@/core/schemas';

/** 2: adds the learner's extra instructions section. */
export const PROMPT_VERSION = 2;
export const MAX_CUSTOM_INSTRUCTIONS = 500;

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

/** What each problem type asks of the model (mirrors practice::type_rule). */
export const TYPE_RULES: Record<ProblemType, string> = {
  write_code:
    'write_code: the learner writes a program. Give exact "input_format" and "output_format", at least 2 "samples", a "hint" and a complete, runnable "reference_solution".',
  predict_output:
    'predict_output: "code" is a short program that reads no input; the learner says exactly what it prints. Put the exact printed text in "expected_output".',
  find_bug:
    'find_bug: "code" is a short program with exactly one bug and "statement" says what it should do. "reference_solution" is the fixed program and "explanation" names the bug.',
  fill_blank:
    'fill_blank: "code" is a short program with gaps written as ___ (three underscores); "blanks" lists what goes in each gap, in order (one entry per gap).',
  multiple_choice:
    'multiple_choice: "statement" is the question (put any code in "code"); "options" has 3 or 4 answers and "correct_option" is the 0-based index of the right one.',
};

const base = (type: ProblemType) => ({
  type,
  title: 'Short title',
  difficulty: 1,
  concepts: ['concept name from the list'],
});

/** One example problem per type, as the model should write it. */
export const TYPE_EXAMPLES: Record<ProblemType, GeneratedProblem> = {
  write_code: {
    ...base('write_code'),
    statement: 'What to do, in plain language.',
    input_format: 'Exactly what the input looks like.',
    output_format: 'Exactly what to print.',
    constraints: 'Optional limits, e.g. 1 <= n <= 100',
    samples: [
      { input: '3\n', output: '6\n', explanation: 'optional' },
      { input: '1\n', output: '1\n' },
    ],
    hint: "A nudge that doesn't give the answer away.",
    reference_solution: 'complete runnable code',
    explanation: 'optional: why the answer works',
  },
  predict_output: {
    ...base('predict_output'),
    statement: 'What does this program print?',
    code: 'for i in range(3):\n    print(i * 2)',
    expected_output: '0\n2\n4',
    hint: 'Work out each round of the loop on paper.',
    explanation: 'i is 0, 1, 2, so it prints 0, 2 and 4.',
  },
  find_bug: {
    ...base('find_bug'),
    statement: "This should print the numbers 1 to 5, but it doesn't. Find and fix the bug.",
    code: 'for i in range(1, 5):\n    print(i)',
    reference_solution: 'for i in range(1, 6):\n    print(i)',
    hint: 'Check where the range stops.',
    explanation: 'range stops before its end value, so it should be range(1, 6).',
  },
  fill_blank: {
    ...base('fill_blank'),
    statement: 'Fill in the blanks so the program prints the sum of the list.',
    code: 'total = ___\nfor x in [1, 2, 3]:\n    total ___ x\nprint(total)',
    blanks: ['0', '+='],
    hint: 'Start the total at nothing, then add each number.',
    explanation: 'total starts at 0 and += adds each x.',
  },
  multiple_choice: {
    ...base('multiple_choice'),
    statement: 'What does len("hello") return?',
    options: ['4', '5', '6', 'an error'],
    correct_option: 1,
    hint: 'Count the letters.',
    explanation: '"hello" has 5 characters.',
  },
};

export function jsonShapeFor(types: ProblemType[]): string {
  return JSON.stringify({ problems: types.map((t) => TYPE_EXAMPLES[t]) }, null, 2);
}

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
  custom_instructions?: string | null;
  types?: ProblemType[];
}

export function buildGeneratePrompt(v: PromptVars): string {
  const list = v.concepts.map((c) => `- ${c.name}${c.note ? `: ${c.note}` : ''}`).join('\n');
  const struggles = v.struggles.length
    ? `Recent struggles (include at least one gentle problem on these ideas):\n${v.struggles.map((s) => `- ${s}`).join('\n')}\n`
    : '';
  const extra = v.custom_instructions?.trim()
    ? `LEARNER'S EXTRA INSTRUCTIONS (follow unless they break the rules above):
${v.custom_instructions.trim()}

`
    : '';
  const types = v.types?.length ? v.types : (['write_code'] as ProblemType[]);
  const mix = types.length > 1 ? 'Mix these types across the set.' : '';
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

PROBLEM TYPES
Use these types: ${types.join(', ')}. ${mix}
${types.map((t) => `- ${TYPE_RULES[t]}`).join('\n')}
Every problem has a "type" field with one of these names.
${struggles}
RULES
- Each problem practices at least one listed concept.
- Write clear, unambiguous statements.
- All code is ${v.language} using only the listed concepts. Before answering,
  mentally run every piece of code and make sure outputs, answers and samples
  match it exactly.
- The hint nudges without giving the answer away.
- "explanation" briefly says why the answer is right; it is shown after the
  learner answers.

${extra}OUTPUT
Return ONLY valid JSON matching this shape, with no markdown and no extra text:
${jsonShapeFor(types)}
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
  types: ProblemType[] = [],
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
    if (p.samples?.some((s) => !s.input.trim() && !s.output.trim())) {
      warnings.push(`Problem ${n} has an empty sample.`);
    }
    if (types.length && !types.includes(p.type ?? 'write_code')) {
      warnings.push(`Problem ${n} is a "${p.type}" problem, which you didn't ask for.`);
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
