import { errorKind, errorSignature, extractErrorLine, findErrorMatch } from '@/lib/errors';

const PY_TRACE = `Traceback (most recent call last):
  File "C:\\Users\\sam\\main.py", line 3, in <module>
    print(xs[5])
IndexError: list index out of range`;

describe('extractErrorLine', () => {
  it('takes the last line of a Python traceback', () => {
    expect(extractErrorLine(PY_TRACE)).toBe('IndexError: list index out of range');
  });

  it('finds compiler-style errors', () => {
    expect(
      extractErrorLine(
        "main.cpp: In function 'int main()':\nmain.cpp:4:5: error: expected ';' before 'return'",
      ),
    ).toBe("main.cpp:4:5: error: expected ';' before 'return'");
    expect(
      extractErrorLine(
        'Exception in thread "main" java.lang.ArithmeticException: / by zero\n\tat Main.main(Main.java:3)',
      ),
    ).toMatch(/ArithmeticException/);
    expect(extractErrorLine('Segmentation fault (core dumped)')).toBe(
      'Segmentation fault (core dumped)',
    );
  });

  it('returns null for normal output', () => {
    expect(extractErrorLine('0\n1\n2')).toBeNull();
    expect(extractErrorLine('Total errors fixed: 3')).toBeNull();
    expect(extractErrorLine('')).toBeNull();
  });
});

describe('signatures and matching', () => {
  it('ignores positions, paths, numbers and quoted values', () => {
    expect(errorSignature("main.py:3: NameError: name 'totl' is not defined")).toBe(
      errorSignature('main.py:17: NameError: name "count" is not defined'),
    );
    expect(errorKind('TypeError: x')).toBe('TypeError');
    expect(errorKind('a.c:1:1: error: y')).toBe('error');
  });

  const notes = [
    { id: 'a', message: 'IndexError: list index out of range' },
    { id: 'b', message: 'TypeError: can only concatenate str (not "int") to str' },
    { id: 'c', message: "NameError: name 'x' is not defined" },
  ];

  it('matches the same error seen again', () => {
    expect(findErrorMatch(PY_TRACE, notes)?.note.id).toBe('a');
    expect(
      findErrorMatch('TypeError: can only concatenate str (not "float") to str', notes)?.note.id,
    ).toBe('b');
    expect(findErrorMatch("NameError: name 'totl' is not defined", notes)).toMatchObject({
      note: { id: 'c' },
      score: 1,
    });
  });

  it('does not match a different error of another kind', () => {
    expect(findErrorMatch('ZeroDivisionError: division by zero', notes)).toBeNull();
    expect(
      findErrorMatch('TypeError: unsupported operand type(s) for +: int and NoneType', notes),
    ).toBeNull();
    expect(findErrorMatch('all good', notes)).toBeNull();
  });
});
