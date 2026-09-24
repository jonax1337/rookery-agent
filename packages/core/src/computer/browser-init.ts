/// <reference lib="dom" />
/// <reference lib="dom.asynciterable" />
import { CURSOR } from './cursor.js';

/** Serialized by Playwright and executed in the page, with no module dependencies. */
export function installCursor(style: typeof CURSOR): void {
  const cursor = document.createElement('rookery-cursor');
  cursor.setAttribute('aria-hidden', 'true');
  const shadow = cursor.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        left: 0; top: 0;
        width: ${style.size}px; height: ${style.size}px;
        z-index: 2147483647;
        display: none;
      }
      :host, :host * { pointer-events: none !important; }
      svg {
        position: absolute;
        left: -${style.hotspot}px; top: -${style.hotspot}px;
        overflow: visible;
        filter: drop-shadow(0 1px 2px #071e2440) drop-shadow(0 0 5px ${style.glow}80);
      }
      .halo, .pulse {
        position: absolute;
        left: 0; top: 0;
        border-radius: 50%;
        transform: translate(-50%, -50%);
      }
      .halo {
        width: 36px; height: 36px;
        background: radial-gradient(circle, ${style.glow}30, ${style.glow}00 70%);
      }
      .pulse { width: 28px; height: 28px; border: 1px solid ${style.glow}; opacity: 0; }
      .badge {
        position: absolute; left: 22px; top: 24px;
        display: flex; align-items: center; gap: 7px;
        padding: 6px 10px; border-radius: 9px;
        border: 1px solid ${style.glow}55; background: #121e1df0;
        color: #eef9f5; font: 11px/1.2 "Segoe UI", system-ui, sans-serif;
        white-space: nowrap; box-shadow: 0 3px 12px #071e2420;
      }
      .brand { font-weight: 600; }
      .state { color: #b6cbc4; }
    </style>
    <span class="halo"></span><span class="pulse"></span>
    <svg width="${style.size}" height="${style.size}" viewBox="0 0 24 24">
      <path d="${style.path}" fill="${style.fill}" stroke="${style.outline}"
        stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.innerHTML = '<span class="brand">Rookery</span><span class="state">Ready</span>';
  shadow.appendChild(badge);

  const pulse = shadow.querySelector('.pulse')!;
  const status = badge.querySelector('.state')!;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let current: { x: number; y: number } | undefined;
  let target = { x: 0, y: 0 };
  let frame = 0;
  let previousTime = 0;
  let clickPending = false;
  let ripple: Animation | undefined;
  let idleTimer = 0;

  const showStatus = (text: string): void => {
    status.textContent = text;
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => { status.textContent = 'Waiting'; }, 2000);
  };

  const render = (time: number): void => {
    frame = 0;
    const amount = reducedMotion.matches ? 1 : 1 - Math.exp(-(time - previousTime) / 32);
    previousTime = time;
    const point = current!;
    point.x += (target.x - point.x) * amount;
    point.y += (target.y - point.y) * amount;
    const arrived = Math.hypot(target.x - point.x, target.y - point.y) < 0.25;
    if (arrived) Object.assign(point, target);
    cursor.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    badge.style.left = point.x + 190 > window.innerWidth ? '-174px' : '22px';
    badge.style.top = point.y + 60 > window.innerHeight ? '-30px' : '24px';

    if (!arrived) {
      frame = requestAnimationFrame(render);
    } else if (clickPending) {
      clickPending = false;
      ripple?.cancel();
      if (!reducedMotion.matches) {
        ripple = pulse.animate([
          { opacity: 0.65, transform: 'translate(-50%, -50%) scale(0.35)' },
          { opacity: 0, transform: 'translate(-50%, -50%) scale(1.4)' },
        ], { duration: 280, easing: 'ease-out' });
      }
    }
  };

  const moveTo = (x: number, y: number, action: string, click = false): void => {
    if (!cursor.isConnected) document.documentElement.appendChild(cursor);
    target = { x, y };
    current ??= { ...target };
    clickPending ||= click;
    showStatus(action);
    cursor.style.display = 'block';
    if (!frame) {
      previousTime = performance.now();
      frame = requestAnimationFrame(render);
    }
  };

  document.addEventListener('mousemove', (event) => moveTo(event.clientX, event.clientY, 'Moving'), true);
  document.addEventListener('mousedown', (event) => moveTo(event.clientX, event.clientY, 'Clicking', true), true);
  document.addEventListener('wheel', (event) => moveTo(event.clientX, event.clientY, 'Scrolling'), { capture: true, passive: true });
  const atElement = (event: Event): void => {
    if (event.type === 'focusin' && clickPending) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    moveTo(rect.x + rect.width / 2, rect.y + rect.height / 2, event.type === 'input' ? 'Typing' : 'Keyboard');
  };
  document.addEventListener('focusin', atElement, true);
  document.addEventListener('input', atElement, true);
  document.addEventListener('keydown', atElement, true);
}

export default async function init({ page }: {
  page: { addInitScript(script: typeof installCursor, argument: typeof CURSOR): Promise<void> };
}): Promise<void> {
  await page.addInitScript(installCursor, CURSOR);
}
