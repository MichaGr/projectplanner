import { memo, useEffect, useRef } from 'react';

const config = {
  spacing: 26,
  attractRadius: 148,
  maxOffset: 22,
  dotRadius: 0.9,
  damping: 0.84,
  homePull: 0.045,
  attractPull: 0.14,
  settleThreshold: 0.018,
};

type Particle = {
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export const ParticleGridBackground = memo(function ParticleGridBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const context = canvas?.getContext('2d');
    if (!canvas || !host || !context) return;

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    const pointer = { x: 0, y: 0, active: false };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const drawParticles = () => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = 'rgba(225, 195, 255, 0.38)';
      for (const particle of particles) {
        context.beginPath();
        context.arc(particle.x, particle.y, config.dotRadius, 0, Math.PI * 2);
        context.fill();
      }
    };

    const rebuildParticles = () => {
      particles = [];
      const columns = Math.ceil(width / config.spacing) + 4;
      const rows = Math.ceil(height / config.spacing) + 4;
      const startX = config.spacing * 0.5;
      const startY = config.spacing * 0.5;

      for (let row = -2; row < rows - 2; row += 1) {
        for (let column = -2; column < columns - 2; column += 1) {
          const homeX = startX + column * config.spacing;
          const homeY = startY + row * config.spacing;
          particles.push({ homeX, homeY, x: homeX, y: homeY, vx: 0, vy: 0 });
        }
      }
    };

    const render = () => {
      animationFrame = 0;
      let maximumMotion = 0;

      for (const particle of particles) {
        const pointerX = pointer.x - particle.homeX;
        const pointerY = pointer.y - particle.homeY;
        const pointerDistance = Math.hypot(pointerX, pointerY);
        let targetX = particle.homeX;
        let targetY = particle.homeY;

        if (pointer.active && pointerDistance < config.attractRadius) {
          const influence = 1 - pointerDistance / config.attractRadius;
          const offset = Math.min(config.maxOffset, influence * config.maxOffset);
          const direction = Math.max(pointerDistance, 0.001);
          targetX += (pointerX / direction) * offset;
          targetY += (pointerY / direction) * offset;
          particle.vx += (targetX - particle.x) * config.attractPull * influence;
          particle.vy += (targetY - particle.y) * config.attractPull * influence;
        } else {
          particle.vx += (targetX - particle.x) * config.homePull;
          particle.vy += (targetY - particle.y) * config.homePull;
        }

        particle.vx *= config.damping;
        particle.vy *= config.damping;
        particle.x += particle.vx;
        particle.y += particle.vy;
        maximumMotion = Math.max(
          maximumMotion,
          Math.abs(particle.vx),
          Math.abs(particle.vy),
          Math.abs(targetX - particle.x),
          Math.abs(targetY - particle.y),
        );
      }

      drawParticles();
      if (maximumMotion > config.settleThreshold && !document.hidden && !reduceMotion.matches) {
        animationFrame = window.requestAnimationFrame(render);
      }
    };

    const scheduleRender = () => {
      if (!animationFrame && !document.hidden && !reduceMotion.matches) {
        animationFrame = window.requestAnimationFrame(render);
      }
    };

    const resizeCanvas = () => {
      const bounds = host.getBoundingClientRect();
      width = Math.max(1, Math.floor(bounds.width));
      height = Math.max(1, Math.floor(bounds.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildParticles();
      drawParticles();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = true;
      scheduleRender();
    };

    const handlePointerLeave = () => {
      pointer.active = false;
      scheduleRender();
    };

    const handleVisibilityChange = () => {
      if (document.hidden && animationFrame) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else {
        drawParticles();
      }
    };

    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(host);
    host.addEventListener('pointermove', handlePointerMove, { passive: true });
    host.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resizeCanvas();

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      host.removeEventListener('pointermove', handlePointerMove);
      host.removeEventListener('pointerleave', handlePointerLeave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return <canvas ref={canvasRef} className={className ?? 'particle-grid'} aria-hidden="true" />;
});
