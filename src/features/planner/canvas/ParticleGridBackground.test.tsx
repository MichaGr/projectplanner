import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticleGridBackground } from './ParticleGridBackground';

describe('ParticleGridBackground', () => {
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    frames.length = 0;
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setTransform: vi.fn(),
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not run animation frames while idle and stops after settling', () => {
    const { container } = render(<div><ParticleGridBackground /></div>);
    const host = container.firstElementChild!;
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    fireEvent.pointerMove(host, { clientX: 1, clientY: 1 });
    expect(frames).toHaveLength(1);

    let iterations = 0;
    while (frames.length > 0 && iterations < 1000) {
      frames.shift()!(iterations * 16);
      iterations += 1;
    }

    expect(iterations).toBeGreaterThan(1);
    expect(iterations).toBeLessThan(1000);
    expect(frames).toHaveLength(0);
  });
});
