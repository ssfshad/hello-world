/**
 * The only place that talks to the backend. In the Tauri shell this is
 * `invoke()`; in a plain browser (npm run dev) an in-memory mock backend is
 * loaded on demand so every screen can be exercised.
 */
import type {
  AppErrorPayload,
  CommandArgs,
  CommandName,
  CommandResult,
  ErrorCode,
} from '@/core/types/api';

export type Invoker = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export class AppError extends Error {
  code: ErrorCode;
  constructor(payload: AppErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.name = 'AppError';
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    return new AppError(e as AppErrorPayload);
  }
  if (typeof e === 'string') return new AppError({ code: 'INTERNAL', message: e });
  if (e instanceof Error) return new AppError({ code: 'INTERNAL', message: e.message });
  return new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
}

let invokerPromise: Promise<Invoker> | null = null;
let override: Invoker | null = null;

/** Tests can inject a fake backend. */
export function setInvoker(fn: Invoker | null): void {
  override = fn;
}

function getInvoker(): Promise<Invoker> {
  if (override) return Promise.resolve(override);
  if (!invokerPromise) {
    invokerPromise = isTauri()
      ? import('@tauri-apps/api/core').then((m) => m.invoke as Invoker)
      : import('./mock').then((m) => m.mockInvoke);
  }
  return invokerPromise;
}

type ArgsTuple<K extends CommandName> =
  CommandArgs<K> extends Record<string, never> ? [] | [CommandArgs<K>] : [CommandArgs<K>];

export async function call<K extends CommandName>(
  name: K,
  ...args: ArgsTuple<K>
): Promise<CommandResult<K>> {
  const invoker = await getInvoker();
  try {
    return (await invoker(name, (args[0] ?? {}) as Record<string, unknown>)) as CommandResult<K>;
  } catch (e) {
    throw toAppError(e);
  }
}
