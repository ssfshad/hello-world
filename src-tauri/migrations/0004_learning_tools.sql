-- Learning tools (2026-09-26): error journal, glossary and weekly reviews.

-- Errors the learner hit, what caused them and how they fixed them. `message`
-- is the error text as printed; matching against new output happens in the UI.
CREATE TABLE error_notes (
  id          TEXT PRIMARY KEY,
  language_id TEXT REFERENCES languages(id),
  message     TEXT NOT NULL,
  cause       TEXT,
  fix         TEXT,
  concept_id  TEXT REFERENCES concepts(id),
  problem_id  TEXT REFERENCES problems(id),
  hits        INTEGER NOT NULL DEFAULT 1,
  last_hit_at TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_error_notes_day ON error_notes(day_key);

-- Words a beginner trips over. Built-in terms are language-neutral; the
-- learner can edit them (they stop being built-in) or add their own.
CREATE TABLE glossary_terms (
  id          TEXT PRIMARY KEY,
  term        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  language_id TEXT REFERENCES languages(id),
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- One reflection per week; week_start is the Monday day_key.
CREATE TABLE weekly_reviews (
  week_start  TEXT PRIMARY KEY,
  clicked     TEXT,
  fuzzy       TEXT,
  focus       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO glossary_terms (id, term, definition, is_builtin, created_at, updated_at) VALUES
  ('gt-variable',   'variable',   'A name that points to a value, so you can use and change it later.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-function',   'function',   'A named block of code you can run again and again by calling it.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-parameter',  'parameter',  'The name a function uses for an input, written in its definition: def greet(name).', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-argument',   'argument',   'The actual value you pass when calling a function: greet("Ana").', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-return',     'return',     'Sends a value back from a function to the code that called it. Different from print, which only shows it.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-loop',       'loop',       'Code that repeats: for goes over items, while repeats until a condition is false.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-iteration',  'iteration',  'One pass through a loop.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-condition',  'condition',  'An expression that is true or false, used by if and while to decide what to do.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-boolean',    'boolean',    'A value that is either true or false.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-string',     'string',     'Text, written in quotes: "hello".', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-integer',    'integer',    'A whole number with no decimal point, like 7 or -3.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-array',      'array',      'An ordered collection of values you reach by position (index). Python calls it a list.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-index',      'index',      'The position of an item in a list or string. Counting starts at 0.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-scope',      'scope',      'Where in the code a name can be used. A variable made inside a function only exists inside it.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-mutable',    'mutable',    'Can be changed after it is created. Lists are mutable; strings are not.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-syntax',     'syntax',     'The grammar rules of a language: where brackets, colons and quotes must go.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-expression', 'expression', 'A piece of code that produces a value, like 2 + 3 or len(name).', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-statement',  'statement',  'One complete instruction, like x = 5 or print(x).', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-bug',        'bug',        'A mistake that makes a program do the wrong thing. Finding and fixing it is debugging.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-exception',  'exception',  'An error that happens while the program runs, like dividing by zero. It stops the program unless handled.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-compiler',   'compiler',   'A program that turns your code into something the computer can run, and reports errors first.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-recursion',  'recursion',  'When a function calls itself on a smaller piece of the problem until it reaches a simple case.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-algorithm',  'algorithm',  'A step-by-step plan for solving a problem.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-class',      'class',      'A blueprint for making objects that bundle data and the functions that work on it.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-object',     'object',     'A thing made from a class, with its own data.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-method',     'method',     'A function that belongs to an object, called with a dot: name.upper().', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-dictionary', 'dictionary', 'A collection of key → value pairs, for looking things up by name. Also called a map.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z'),
  ('gt-debugging',  'debugging',  'Finding out why code misbehaves, for example by printing values step by step.', 1, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z');
