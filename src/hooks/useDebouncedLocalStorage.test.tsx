import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedLocalStorage } from './useDebouncedLocalStorage';

describe('useDebouncedLocalStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
  });

  afterEach(() => vi.useRealTimers());

  it('writes only the latest value after the debounce', () => {
    const { rerender } = renderHook(({ value }) => useDebouncedLocalStorage('planner', value, 100), {
      initialProps: { value: { title: 'first' } },
    });
    rerender({ value: { title: 'latest' } });

    expect(window.localStorage.getItem('planner')).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(window.localStorage.getItem('planner')).toBe('{"title":"latest"}');
  });

  it('flushes pending state when the page is hidden', () => {
    renderHook(() => useDebouncedLocalStorage('planner', { title: 'pending' }, 100));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(window.localStorage.getItem('planner')).toBe('{"title":"pending"}');
  });
});
