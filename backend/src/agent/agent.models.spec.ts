import {
  MODEL_CATALOG,
  fallbackFor,
  resolveModel,
} from './agent.models';

describe('agent models catalog', () => {
  it('defaults to ds4-flash', () => {
    const def = resolveModel(undefined);
    expect(def.id).toBe('ds4-flash');
    expect(def.is_default).toBe(true);
  });

  it('resolves known ids and falls back to the default for unknown ids', () => {
    expect(resolveModel('qwen3.6-35b').id).toBe('qwen3.6-35b');
    expect(resolveModel('qqq-does-not-exist').id).toBe('ds4-flash');
    expect(resolveModel('').id).toBe('ds4-flash');
    expect(resolveModel(null).id).toBe('ds4-flash');
  });

  it('exposes exactly the two configured models with stable ids', () => {
    expect(MODEL_CATALOG.map((m) => m.id).sort()).toEqual([
      'ds4-flash',
      'qwen3.6-35b',
    ]);
    expect(MODEL_CATALOG.find((m) => m.id === 'ds4-flash')?.is_fallback).toBe(
      true,
    );
    expect(MODEL_CATALOG.find((m) => m.id === 'ds4-flash')?.context_window).toBe(
      131000,
    );
    expect(MODEL_CATALOG.find((m) => m.id === 'qwen3.6-35b')?.context_window).toBe(
      131000,
    );
  });

  it('never falls back from the fallback (avoids loops)', () => {
    const def = resolveModel('ds4-flash');
    expect(fallbackFor(def)).toBeNull();
    expect(fallbackFor(resolveModel('qwen3.6-35b'))?.id).toBe('ds4-flash');
  });
});
