import { useEffect, useRef } from 'react';

export function useDebouncedLocalStorage<T>(key: string, value: T, delay = 200) {
  const latestValue = useRef(value);
  const timer = useRef<number | null>(null);

  latestValue.current = value;

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      window.localStorage.setItem(key, JSON.stringify(latestValue.current));
      timer.current = null;
    }, delay);

    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [delay, key, value]);

  useEffect(() => {
    const flush = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      window.localStorage.setItem(key, JSON.stringify(latestValue.current));
    };

    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [key]);
}
