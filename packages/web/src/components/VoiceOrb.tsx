import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The orb: a full-viewport WebGL shader, no dependencies.
 *
 * A plasma sphere with a noise-displaced outline, a fresnel rim and a wide
 * glow, on a dark HUD-style ground. It carries real state: the outline and
 * glow move with the audio level (the microphone while listening, the voice
 * while speaking), rotating arcs appear while the model thinks, and ripples
 * roll outward while it talks. Colours cross-fade between states.
 *
 * Everything animates on the GPU; React only owns the canvas and the loop.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface VoiceOrbProps {
  state: OrbState;
  /** 0..1 loudness, read every frame. */
  getLevel(): number;
  /** Fades the scene down, for the start gate. */
  dim?: boolean;
  className?: string;
}

type Rgb = [number, number, number];

/** Base and highlight colour per state. */
const COLORS: Record<OrbState, [Rgb, Rgb]> = {
  idle: [
    [0.1, 0.35, 0.95],
    [0.15, 0.85, 1.0],
  ],
  listening: [
    [0.05, 0.72, 0.78],
    [0.45, 1.0, 0.72],
  ],
  thinking: [
    [0.45, 0.25, 1.0],
    [0.95, 0.45, 1.0],
  ],
  speaking: [
    [0.1, 0.62, 1.0],
    [1.0, 0.78, 0.35],
  ],
};

const WEIGHT_INDEX: Record<OrbState, number> = { idle: 0, listening: 1, thinking: 2, speaking: 3 };

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_level;
uniform vec4 u_w;
uniform vec3 u_colA;
uniform vec3 u_colB;
uniform float u_dim;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * snoise(p);
    p = p * 2.02 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  // The orb sits a little above centre so the captions have room below it.
  uv.y -= 0.06;
  float t = u_time;
  float r = length(uv);
  float ang = atan(uv.y, uv.x);
  float listen = u_w.y;
  float think = u_w.z;
  float speak = u_w.w;
  float lvl = u_level;

  // Ground: near-black blue, a faint grid that fades out, drifting dust.
  vec3 col = vec3(0.012, 0.016, 0.03);
  vec2 g = abs(fract(uv * 14.0) - 0.5);
  float grid = smoothstep(0.47, 0.5, max(g.x, g.y));
  col += grid * 0.03 * vec3(0.3, 0.6, 1.0) * (1.0 - smoothstep(0.15, 0.85, r));
  float dust = smoothstep(0.66, 0.92, snoise(vec3(uv * 9.0, t * 0.05)));
  col += dust * 0.06 * u_colA;

  // Body radius: a slow breath, plus the audio level.
  float R = 0.19 + 0.012 * sin(t * 1.3) + lvl * 0.045 + speak * 0.008;

  // Outline: noise sampled around the circumference so the blob stays smooth.
  vec3 ring = vec3(cos(ang), sin(ang), 0.0);
  float n1 = fbm(ring * 1.25 + vec3(0.0, 0.0, t * 0.35));
  float n2 = fbm(ring * 2.6 + vec3(5.0, 2.0, t * 0.7));
  float wob = n1 * 0.032 * (1.0 + lvl * 2.5 + think * 0.5) + n2 * 0.006 * (1.0 + lvl * 3.0);
  float edge = R + wob;
  float d = r - edge;

  // Inner plasma: domain-warped fbm between the two state colours.
  vec3 p = vec3(uv * 2.6, t * 0.22);
  vec3 warp = vec3(fbm(p + vec3(1.7, 9.2, 0.0)), fbm(p + vec3(8.3, 2.8, 0.0)), 0.0);
  float plasma = fbm(p + warp * (0.9 + lvl * 0.6));
  vec3 inner = mix(u_colA, u_colB, smoothstep(-0.45, 0.55, plasma));
  float core = smoothstep(edge * 0.95, 0.0, r);
  inner += core * (0.3 + lvl * 0.3);
  float depth = clamp(-d / max(edge, 0.001), 0.0, 1.0);
  float fres = pow(1.0 - depth, 3.0);
  vec3 body = inner * (0.55 + 0.45 * (1.0 - fres)) + fres * u_colB * 1.5;
  float inside = 1.0 - smoothstep(-0.003, 0.003, d);

  // Glow outside the body, wider when loud.
  float glow = exp(-max(d, 0.0) * (13.0 - lvl * 4.0)) * (0.5 + lvl * 0.9 + speak * 0.15);
  vec3 glowCol = mix(u_colA, u_colB, 0.5);
  col += glowCol * glow * (1.0 - inside);
  col = mix(col, body, inside);

  // Thinking: two rotating segmented arcs.
  float arcR = R + 0.075;
  float seg1 = step(0.5, fract((ang + t * 1.8) / 6.2831 * 3.0));
  float ring1 = 1.0 - smoothstep(0.0, 0.006, abs(r - arcR));
  float seg2 = step(0.58, fract((ang - t * 1.1) / 6.2831 * 2.0 + 0.3));
  float ring2 = 1.0 - smoothstep(0.0, 0.004, abs(r - (arcR + 0.035)));
  col += u_colB * (ring1 * seg1 + ring2 * seg2 * 0.7) * think * 1.4;

  // Listening: a thin ring that opens with the microphone.
  float lisR = R + 0.05 + lvl * 0.14;
  float lis = (1.0 - smoothstep(0.0, 0.01, abs(r - lisR))) * listen * (0.3 + lvl * 1.0);
  col += u_colB * lis * 1.2;

  // Speaking: ripples rolling outward, louder means brighter.
  float w = sin((r - R) * 90.0 - t * 7.0);
  float waves = smoothstep(0.75, 1.0, w) * exp(-(r - R) * 9.0) * step(0.0, d) * speak * (0.2 + lvl * 1.2);
  col += glowCol * waves;

  // Finish: faint scanlines, vignette, dim, soft tonemap.
  col *= 1.0 - 0.05 * sin(gl_FragCoord.y * 1.5);
  col *= 1.0 - smoothstep(0.5, 1.25, r) * 0.6;
  col *= mix(1.0, 0.35, u_dim);
  col = col / (1.0 + col * 0.35);
  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Orb shader failed to compile:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function VoiceOrb({ state, getLevel, dim = false, className }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const dimRef = useRef(dim);
  dimRef.current = dim;
  const levelRef = useRef(getLevel);
  levelRef.current = getLevel;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) {
      canvas.dataset.fallback = 'true';
      return;
    }

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Orb program failed to link:', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    // One triangle that covers the clip space; the fragment shader does the rest.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniform = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    const uRes = uniform('u_res');
    const uTime = uniform('u_time');
    const uLevel = uniform('u_level');
    const uW = uniform('u_w');
    const uColA = uniform('u_colA');
    const uColB = uniform('u_colB');
    const uDim = uniform('u_dim');

    let width = 0;
    let height = 0;
    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const nextWidth = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const nextHeight = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // Smoothed per-frame values, so state changes cross-fade instead of cutting.
    const weights = [1, 0, 0, 0];
    const colA: Rgb = [...COLORS.idle[0]];
    const colB: Rgb = [...COLORS.idle[1]];
    let level = 0;
    let dimmed = dim ? 1 : 0;
    let frame = 0;
    const start = performance.now();
    let last = start;

    const draw = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = 1 - Math.exp(-dt * 5);
      const target = WEIGHT_INDEX[stateRef.current];
      for (let index = 0; index < 4; index += 1) {
        weights[index] = (weights[index] ?? 0) + (((index === target ? 1 : 0) - (weights[index] ?? 0)) * k);
      }
      const [wantA, wantB] = COLORS[stateRef.current];
      for (let index = 0; index < 3; index += 1) {
        colA[index] = (colA[index] ?? 0) + (((wantA[index] ?? 0) - (colA[index] ?? 0)) * k);
        colB[index] = (colB[index] ?? 0) + (((wantB[index] ?? 0) - (colB[index] ?? 0)) * k);
      }
      const wantLevel = Math.max(0, Math.min(1, levelRef.current()));
      level = wantLevel > level ? wantLevel : level + (wantLevel - level) * Math.min(1, dt * 8);
      dimmed += ((dimRef.current ? 1 : 0) - dimmed) * k;

      gl.uniform2f(uRes, width, height);
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform1f(uLevel, level);
      gl.uniform4f(uW, weights[0] ?? 0, weights[1] ?? 0, weights[2] ?? 0, weights[3] ?? 0);
      gl.uniform3f(uColA, colA[0], colA[1], colA[2]);
      gl.uniform3f(uColB, colB[0], colB[1], colB[2]);
      gl.uniform1f(uDim, dimmed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
    // The refs carry state and dim; the GL setup must run exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        'block h-full w-full bg-voice-stage',
        // No WebGL: a still gradient keeps the screen from going blank.
        'data-[fallback=true]:bg-[radial-gradient(circle_at_center,#1e64ff_0%,#0b1a3a_22%,#03040a_60%)]',
        className,
      )}
    />
  );
}
