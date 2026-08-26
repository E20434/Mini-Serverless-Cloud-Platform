import path from 'path';
import { executeFunction } from '../src/executor';

const fn = (name: string) => path.join(__dirname, '..', 'functions', name);

describe('executeFunction', () => {
  it("returns a success outcome with the handler's return value (functions/hello.js)", async () => {
    const outcome = await executeFunction(fn('hello.js'), { name: 'Ada' });

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result).toEqual({ message: 'Hello, Ada!' });
    }
  });

  it('returns an error outcome - not a crash - when the handler throws (functions/throws.js)', async () => {
    const outcome = await executeFunction(fn('throws.js'), {});

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toMatch(/Something went wrong/);
    }
  });

  it('returns a timeout outcome when the handler never resolves within timeoutMs (functions/hangs.js)', async () => {
    // A short timeoutMs keeps this test fast instead of waiting out the
    // 3000ms default.
    const outcome = await executeFunction(fn('hangs.js'), {}, { timeoutMs: 200 });

    expect(outcome.status).toBe('timeout');
  });

  it('supports a synchronous (non-async) handler (functions/sync.js)', async () => {
    const outcome = await executeFunction(fn('sync.js'), {});

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.result).toEqual({ message: 'I am not async, but I still work' });
    }
  });

  it('returns an error outcome when the module has no exported handler (functions/no-handler.js)', async () => {
    const outcome = await executeFunction(fn('no-handler.js'), {});

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toMatch(/does not export/);
    }
  });

  it('reports a durationMs on every outcome, including failures', async () => {
    const outcomes = await Promise.all([
      executeFunction(fn('hello.js'), {}),
      executeFunction(fn('throws.js'), {}),
      executeFunction(fn('hangs.js'), {}, { timeoutMs: 100 }),
    ]);

    for (const outcome of outcomes) {
      expect(typeof outcome.durationMs).toBe('number');
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
