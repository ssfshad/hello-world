/**
 * Spotting errors in pasted compiler output and matching them against the
 * learner's error journal, so the app can say "you fixed this before".
 * Pure functions; the journal itself lives in the core.
 */

/** Python / JS / Java style: `IndexError: …`, `TypeError: …`, `java.lang.NullPointerException`. */
const NAMED = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b/;
/** C / C++ / javac / rustc / go style: `main.cpp:3:5: error: expected ';'`, `error[E0382]: …`. */
const GENERIC = /(^|[\s:])(fatal )?error(\[[A-Z0-9]+\])?:/i;
const CRASH =
  /\b(segmentation fault|panicked at|stack overflow|core dumped|undefined reference)\b/i;

/**
 * The line that best names the error, or null when the output looks fine.
 * Python tracebacks end with the error, so the last named error wins.
 */
export function extractErrorLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let named: string | null = null;
  let generic: string | null = null;
  for (const line of lines) {
    // "Traceback (most recent call last):" and `File "x.py", line 3` are context, not the error.
    if (/^traceback\b/i.test(line) || /^file "/i.test(line) || /^at\s/.test(line)) continue;
    if (NAMED.test(line)) named = line;
    else if (!generic && (GENERIC.test(line) || CRASH.test(line))) generic = line;
  }
  return named ?? generic;
}

/** The error's type name, e.g. "IndexError", or "error" for compiler-style errors. */
export function errorKind(line: string): string {
  return line.match(NAMED)?.[1] ?? CRASH.exec(line)?.[1].toLowerCase() ?? 'error';
}

/**
 * A comparable fingerprint: drops file paths, positions, quoted values and
 * numbers, so "list index out of range" on line 3 and line 9 look the same.
 */
export function errorSignature(line: string): string {
  return line
    .toLowerCase()
    .replace(
      /[\w./\\-]+\.(py|js|mjs|ts|java|c|cc|cpp|h|hpp|rs|go|rb|php|cs|kt|swift)\b(:\d+)*/g,
      ' file ',
    )
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ' _ ')
    .replace(/\d+/g, ' # ')
    .replace(/[^a-z_#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(sig: string): Set<string> {
  return new Set(sig.split(' ').filter((w) => w.length > 1 && w !== 'file'));
}

/** 0–1 overlap between two signatures (Jaccard over words). */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

export interface ErrorMatch<T> {
  note: T;
  /** 1 = same error, lower = similar */
  score: number;
}

/**
 * Finds the journal entry for the error in `output`. Only entries of the same
 * error kind count, and they must share most of their wording.
 */
export function findErrorMatch<T extends { message: string }>(
  output: string,
  notes: T[],
): ErrorMatch<T> | null {
  const line = extractErrorLine(output);
  if (!line) return null;
  const sig = errorSignature(line);
  const kind = errorKind(line);
  let best: ErrorMatch<T> | null = null;
  for (const note of notes) {
    const noteLine = extractErrorLine(note.message) ?? note.message.trim();
    if (errorKind(noteLine) !== kind) continue;
    const noteSig = errorSignature(noteLine);
    const score = noteSig === sig ? 1 : similarity(sig, noteSig);
    if (score >= 0.6 && (!best || score > best.score)) best = { note, score };
  }
  return best;
}
