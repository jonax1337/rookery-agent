import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { MemoryGraph, MemoryKind, MemoryRelation } from '@/lib/types';

import {
  brainRadius,
  cortexCameraDistance,
  fibrePath,
  layoutCortex,
  pathPoint,
  REGION_LABEL,
  type CortexRegion,
  type Surface,
  type Vec3,
} from './layout';

/**
 * The cortex, lit.
 *
 * Everything drawn here is light on a dark ground: the tissue is a haze of
 * dust over the shape from `layout.ts`, a memory is a glowing neuron on it,
 * a topic a brighter core with its name floating above, and every link is
 * a fibre arcing over the surface with signals running along it. Bloom on
 * top turns the bright bits into light rather than into dots.
 *
 * Borrowed, with thanks: the five-lobed point glow and the merged
 * `LineSegments` fibre buffer from pratapchoudhary's brain portfolio, and
 * the idea of particles riding the threads from SahilK-027's Digital Brain
 * (both MIT). Neither is a dependency - the amount of code was small and the
 * shapes here are our own.
 *
 * The class knows nothing about React: it takes a mount, a palette and a
 * graph, and calls back on hover and click. `MemoryCortex.tsx` is the hull.
 */

export interface CortexPalette {
  mode: 'light' | 'dark';
  background: string;
  entity: string;
  mention: string;
  tissue: string;
  dream: string;
  kinds: Record<MemoryKind, string>;
  relations: Record<MemoryRelation, string>;
}

export interface CortexHit {
  key: string;
  type: 'entity' | 'memory';
  id: string;
  label: string;
  memoryKind?: MemoryKind;
  /** The part of the cortex it sits in, named. */
  region: string;
  /** Where the body is on the canvas, in CSS pixels. */
  x: number;
  y: number;
}

export interface CortexCallbacks {
  onHover(hit: CortexHit | null): void;
  onClick(hit: CortexHit): void;
}

/* -------------------------------- shaders -------------------------------- */

/**
 * The far side of the brain is dimmed in every shader: a neuron on the back
 * is still there, but it no longer competes with the one in front of it.
 * Without this the whole thing reads as a glass ball with dots on both
 * sides, which is exactly the knot the old net was.
 */
const FACING = /* glsl */ `
  float facing(vec3 worldPosition) {
    vec3 outward = normalize(worldPosition);
    vec3 toCamera = normalize(cameraPosition - worldPosition);
    return 0.18 + 0.82 * smoothstep(-0.55, 0.25, dot(outward, toCamera));
  }
`;

const GLOW_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aBoost;
  uniform float uTime;
  uniform float uScale;
  uniform float uBreathe;
  uniform float uReveal;
  varying vec3 vColor;
  varying float vVisibility;
  ${FACING}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float breathe = 1.0 + uBreathe * sin(uTime * 1.4 + aPhase * 6.2831853);
    // Each body surfaces in its own moment of the reveal, staggered by its phase.
    float reveal = smoothstep(aPhase * 0.7, aPhase * 0.7 + 0.3, uReveal);
    float size = aSize * breathe * (1.0 + aBoost * 0.9) * (0.4 + 0.6 * reveal);
    gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 256.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor * (1.0 + aBoost);
    vVisibility = facing(position) * reveal;
  }
`;

/** Five lobes of falloff: a hot pin in the middle, a wide faint halo around it. */
const GLOW_FRAG = /* glsl */ `
  uniform float uLight;
  varying vec3 vColor;
  varying float vVisibility;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = pow(max(0.0, 1.0 - d * 10.0), 5.0) * 2.2;
    float hot = pow(max(0.0, 1.0 - d * 6.0), 4.0) * 1.0;
    float mid = pow(max(0.0, 1.0 - d * 3.5), 3.5) * 0.45;
    float halo = pow(max(0.0, 1.0 - d * 2.0), 4.5) * 0.18;
    float outer = pow(max(0.0, 1.0 - d * 1.3), 7.0) * 0.06;
    float glow = core + hot + mid + halo + outer;
    // Daylight fades opacity, not pigment toward black, as a node disappears.
    vec3 pigment = mix(vColor, vec3(0.92, 0.96, 1.0), (1.0 - smoothstep(0.0, 0.09, d)) * 0.65);
    gl_FragColor = vec4(mix(vColor * glow * vVisibility, pigment, uLight), mix(1.0, clamp(glow * 2.0, 0.0, 1.0) * vVisibility, uLight));
  }
`;

/**
 * The tissue: an opaque surface, lit from above and in front, darker in
 * the grooves and along the fissure, with a faint rim where it turns away.
 * It writes depth, so the far side of the brain hides what is behind it
 * the way a real object would, rather than by the shaders dimming it.
 */
const TISSUE_VERT = /* glsl */ `
  attribute float aFold;
  attribute float aFissure;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPosition;
  varying float vFold;
  varying float vFissure;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = -mv.xyz;
    vPosition = position;
    vFold = aFold;
    vFissure = aFissure;
    gl_Position = projectionMatrix * mv;
  }
`;

const TISSUE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uRim;
  uniform vec3 uBackground;
  uniform float uReveal;
  uniform float uLight;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPosition;
  varying float vFold;
  varying float vFissure;
  // Object-space, smoothly interpolated detail stays attached while the camera moves.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vView);
    float mottling = noise(vPosition * 9.0);
    float detail = noise(vPosition * 62.0);
    // Derivative bump mapping: fine tissue texture without changing the silhouette.
    vec3 dpdx = dFdx(-vView), dpdy = dFdy(-vView);
    vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
    float determinant = dot(dpdx, r1);
    vec3 gradient = sign(determinant) * (dFdx(detail) * r1 + dFdy(detail) * r2);
    N = normalize(abs(determinant) * N - 0.0009 * gradient);
    vec3 L = normalize(vec3(-0.55, 0.85, 0.8));
    vec3 F = normalize(vec3(0.8, 0.05, 0.4));
    float ndl = max(dot(N, L), 0.0);
    float cavity = 1.0 - 0.60 * clamp(-vFold, 0.0, 1.0);
    vec3 coolTissue = mix(vec3(0.88, 0.93, 1.0), vec3(1.04), mottling);
    vec3 warmTissue = mix(vec3(0.94, 0.88, 0.82), vec3(1.06, 1.03, 0.99), mottling);
    vec3 albedo = uColor * mix(coolTissue, warmTissue, uLight);
    // Broad softbox reflection over a dielectric, moist surface (GGX).
    vec3 H = normalize(L + V);
    float ndv = max(dot(N, V), 0.001), ndh = max(dot(N, H), 0.0);
    float roughness = mix(0.43, 0.58, detail);
    float a2 = pow(roughness, 4.0);
    float denom = ndh * ndh * (a2 - 1.0) + 1.0;
    float distribution = a2 / max(3.14159 * denom * denom, 0.0001);
    float k = pow(roughness + 1.0, 2.0) / 8.0;
    float visibility = ndv / (ndv * (1.0 - k) + k) * ndl / (ndl * (1.0 - k) + k);
    float fresnel = 0.028 + 0.972 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    float specular = distribution * visibility * fresnel / max(4.0 * ndv * ndl, 0.001);
    // Scattering and reflections follow each mode's material colour.
    float wrap = pow(max(0.0, (dot(N, L) + 0.45) / 1.45), 2.0);
    vec3 scattered = albedo * mix(vec3(0.55, 0.7, 1.0), vec3(1.0, 0.72, 0.52), uLight) * wrap * 0.20;
    float fill = max(dot(N, F), 0.0) * 0.24;
    vec3 colour = albedo * (mix(0.24, 0.22, uLight) + ndl * 0.95 + fill) * cavity;
    colour += scattered * cavity + mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.96, 0.89), uLight) * specular * ndl * 0.75;
    colour += vec3(0.55, 0.65, 0.8) * pow(1.0 - ndv, 4.0) * 0.055 * cavity;
    gl_FragColor = vec4(mix(uBackground, colour, smoothstep(0.0, 1.0, uReveal)), 1.0);
  }
`;

/**
 * Fibres fade out on the far side almost entirely. A neuron seen through
 * the brain is a faint point; a hundred fibres seen through it are a cage,
 * and the cage is what made the old net a ball. On reveal a fibre draws
 * itself out from its first body to its second, `aAlong` being how far
 * along it each vertex sits.
 */
const FIBRE_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlong;
  uniform float uReveal;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec3 outward = normalize(position);
    vec3 toCamera = normalize(cameraPosition - position);
    float front = 0.04 + 0.96 * smoothstep(-0.1, 0.5, dot(outward, toCamera));
    float drawn = smoothstep(aAlong, aAlong + 0.08, uReveal * 1.08);
    vColor = aColor;
    vAlpha = front * drawn;
  }
`;

const FIBRE_FRAG = /* glsl */ `
  uniform float uLight;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha * mix(0.48, 0.32, uLight));
  }
`;

const PULSE_VERT = /* glsl */ `
  attribute float aProgress;
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uScale;
  uniform float uReveal;
  varying vec3 vColor;
  varying float vProgress;
  varying float vVisibility;
  ${FACING}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 96.0);
    gl_Position = projectionMatrix * mv;
    // Signals only start once the fibres are all drawn.
    vColor = aColor;
    vVisibility = facing(position) * smoothstep(0.85, 1.0, uReveal);
    vProgress = aProgress;
  }
`;

const PULSE_FRAG = /* glsl */ `
  uniform float uLight;
  varying vec3 vColor;
  varying float vProgress;
  varying float vVisibility;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = pow(max(0.0, 1.0 - d * 6.0), 3.0) * 3.0;
    float halo = pow(max(0.0, 1.0 - d * 2.0), 3.0) * 0.6;
    // A signal fades in as it leaves one body and out as it reaches the next.
    float fade = smoothstep(0.0, 0.15, vProgress) * (1.0 - smoothstep(0.82, 1.0, vProgress));
    float glow = (core + halo) * fade;
    gl_FragColor = vec4(mix(vColor * glow * vVisibility, vColor, uLight), mix(1.0, clamp(glow * 2.0, 0.0, 1.0) * vVisibility, uLight));
  }
`;

/* ------------------------------- constants ------------------------------- */

/** The tissue token lit as a surface needs headroom for the shading to have anywhere to go. */
const ORGAN_GAIN = 2.4;
const PULSE_CAPACITY = 480;
const PULSES_AWAKE = 110;
const PULSES_DREAMING = 420;
/** Enough steps for a fibre to follow the grooves it crosses. */
const MENTION_SEGMENTS = 96;
const RELATION_SEGMENTS = 128;
/** Seconds: the brain coming up out of the dark, then the net surfacing on it. */
const TISSUE_REVEAL = 1.4;
const NET_REVEAL = 2.2;
/** How far above the tissue a fibre rides, as a share of the radius. */
const MENTION_LIFT = 0.01;
const RELATION_LIFT = 0.016;
const CAMERA_DISTANCE = 3.7;
const FOV = 38;
/** Seconds of stillness before the brain starts turning again. */
const IDLE_RESUME = 6;
/** Labels beyond this rank only appear once the camera comes close. */
const LABEL_RANK_ALWAYS = 12;

/** Where the model and its decoder are served from; `index.html` preloads both. */
export const MODEL_URL = '/models/brain.glb';
const DRACO_PATH = '/draco/';
/** Which way the model's forehead points along z; flipped here if the file has it backwards. */
const MODEL_FRONT: 1 | -1 = 1;
/** Half the length the model is scaled to, front to back - the formula's `RZ`. */
const MODEL_LENGTH = 1.22;
/**
 * Below this height (in the scaled model) there is only brainstem: measured
 * on the model, the bands under it hold a few dozen vertices within 0.45 of
 * the axis, the band at it holds the cerebellum's whole width. Its axis
 * sits behind the centre.
 */
const BRAINSTEM_BELOW = -0.8;
const BRAINSTEM_AXIS_Z = -0.35;
export type CortexView = 'default' | 'front' | 'side' | 'top' | 'back' | 'bottom';

/** Unit directions the camera looks in from; `default` is the three-quarter view from above and in front. */
const VIEWS: Record<CortexView, THREE.Vector3> = {
  default: new THREE.Vector3(0.7, 0.62, 0.55).normalize(),
  front: new THREE.Vector3(0, 0.15, 1).normalize(),
  side: new THREE.Vector3(1, 0.1, 0).normalize(),
  top: new THREE.Vector3(0.001, 1, 0.001).normalize(),
  back: new THREE.Vector3(0, 0.15, -1).normalize(),
  bottom: new THREE.Vector3(0.45, -0.9, -0.55).normalize(),
};

interface Fibre {
  /** The points it runs through, flat, on the cortex. */
  path: Float32Array;
  colour: THREE.Color;
  /** First vertex in the merged buffer and how many belong to this fibre. */
  start: number;
  count: number;
  relation: boolean;
}

interface Pulse {
  fibre: number;
  t: number;
  speed: number;
}

interface Body {
  key: string;
  type: 'entity' | 'memory';
  id: string;
  label: string;
  memoryKind?: MemoryKind;
  region: CortexRegion;
  position: THREE.Vector3;
  /** Halo diameter in world units. */
  size: number;
  /** Topics only: 1 + log(1 + mentions). */
  weight?: number;
  /**
   * Which point cloud draws it and at what index. Memories inside the
   * brain are a cloud of their own that ignores depth, so the tissue does
   * not swallow them; everything else sits on the surface and is occluded
   * by it like any other object.
   */
  layer: 'cores' | 'surface' | 'deep';
  slot: number;
}

interface Label {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  body: Body;
  dir: THREE.Vector3;
  aspect: number;
  rank: number;
  /** Whether it held a place last frame - a placed name is slow to give it up. */
  placed: boolean;
  /** Its opacity, eased toward where it should be rather than snapped. */
  alpha: number;
}

/* --------------------------------- scene --------------------------------- */

export class CortexScene {
  readonly #mount: HTMLElement;
  readonly #callbacks: CortexCallbacks;
  #palette: CortexPalette;
  #graph: MemoryGraph | null = null;
  #atlas: MemoryGraph | null = null;
  /** The formula until the model has loaded, the model's own surface after. */
  #surface: Surface = brainRadius;
  /** The model's bytes, fetched before the scene existed, if the hull got there first. */
  readonly #modelBytes: Promise<ArrayBuffer | null> | null;

  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera: THREE.PerspectiveCamera;
  readonly #controls: OrbitControls;
  readonly #composer: EffectComposer;
  readonly #bloom: UnrealBloomPass;
  readonly #clock = new THREE.Clock();
  readonly #observer: ResizeObserver;
  readonly #raycaster = new THREE.Raycaster();

  readonly #tissue: THREE.Mesh;
  readonly #tissueMaterial: THREE.ShaderMaterial;
  readonly #neurons: THREE.Points;
  readonly #neuronMaterial: THREE.ShaderMaterial;
  readonly #deepNeurons: THREE.Points;
  readonly #deepMaterial: THREE.ShaderMaterial;
  readonly #cores: THREE.Points;
  readonly #coreMaterial: THREE.ShaderMaterial;
  readonly #fibres: THREE.LineSegments;
  readonly #fibreMaterial: THREE.ShaderMaterial;
  readonly #pulses: THREE.Points;
  readonly #pulseMaterial: THREE.ShaderMaterial;
  readonly #hoverHalo: THREE.Sprite;
  readonly #selectHalo: THREE.Sprite;
  readonly #labelGroup = new THREE.Group();

  #fibreList: Fibre[] = [];
  #fibreColours = new Float32Array(0);
  #adjacency = new Map<string, number[]>();
  #pulseList: Pulse[] = [];
  #memoryBodies: Body[] = [];
  #surfaceBodies: Body[] = [];
  #deepBodies: Body[] = [];
  #entityBodies: Body[] = [];
  #labels: Label[] = [];

  #hovered: string | null = null;
  #selected: string | null = null;
  #dreaming = false;
  #dream = 0;
  /** The brain has been read (or has failed for good) and may come up. */
  #modelSettled = false;
  /** 0..1: how far the tissue has come up, and how far the net has surfaced on it. */
  #tissueReveal = 0;
  #netReveal = 0;
  /** The net surfaces once, the first time there is anything to show; a filter later does not replay it. */
  #netSurfaced = false;
  #reducedMotion = false;
  #idleAt = 0;
  #frame = 0;
  #disposed = false;
  #pointer = new THREE.Vector2(2, 2);
  #pointerDirty = false;
  #pointerDown: { x: number; y: number } | null = null;
  #hidden = false;
  #flight: { from: THREE.Vector3; to: THREE.Vector3; start: number; duration: number } | null = null;

  constructor(
    mount: HTMLElement,
    palette: CortexPalette,
    callbacks: CortexCallbacks,
    options: { model?: Promise<ArrayBuffer | null> } = {},
  ) {
    this.#mount = mount;
    this.#palette = palette;
    this.#callbacks = callbacks;
    this.#modelBytes = options.model ?? null;

    // Throws where there is no WebGL - the hull catches it and says so.
    this.#renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 0.9;
    this.#renderer.domElement.style.display = 'block';
    this.#renderer.domElement.style.touchAction = 'none';
    mount.appendChild(this.#renderer.domElement);

    this.#camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 40);
    this.#camera.position.copy(VIEWS.default).multiplyScalar(CAMERA_DISTANCE);
    // A handle for the dev tools and for scripted screenshots; never in a build.
    if (import.meta.env.DEV) (window as unknown as { __cortex?: CortexScene }).__cortex = this;

    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.07;
    this.#controls.enablePan = false;
    this.#controls.minDistance = 1.6;
    this.#controls.maxDistance = 9;
    this.#controls.autoRotateSpeed = 0.45;
    this.#controls.addEventListener('start', () => {
      this.#idleAt = this.#clock.elapsedTime;
      this.#flight = null;
    });

    // Multisampled: one-pixel fibres over a turning surface shimmer
    // without it. Half float keeps the additive glow above one for bloom.
    this.#composer = new EffectComposer(
      this.#renderer,
      new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }),
    );
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.20, 0.3, 1.05);
    this.#composer.addPass(this.#bloom);
    this.#composer.addPass(new OutputPass());

    /* the organ itself - an empty mesh until the model has been read */
    this.#tissueMaterial = new THREE.ShaderMaterial({
      vertexShader: TISSUE_VERT,
      fragmentShader: TISSUE_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(palette.tissue).multiplyScalar(palette.mode === 'dark' ? ORGAN_GAIN : 1) },
        uRim: { value: new THREE.Color(palette.mention) },
        uBackground: { value: new THREE.Color(palette.background) },
        uReveal: { value: 0 },
        uLight: { value: 0 },
      },
      // The tissue yields a little in the depth test, so a fibre lying just
      // above it wins cleanly instead of fighting it pixel by pixel as the
      // brain turns - that fight was the flicker.
      polygonOffset: true,
      polygonOffsetFactor: 1.5,
      polygonOffsetUnits: 2,
    });
    this.#tissue = new THREE.Mesh(new THREE.BufferGeometry(), this.#tissueMaterial);
    this.#tissue.renderOrder = -1;
    this.#tissue.visible = false;
    this.#scene.add(this.#tissue);

    /* fibres */
    this.#fibreMaterial = new THREE.ShaderMaterial({
      vertexShader: FIBRE_VERT,
      fragmentShader: FIBRE_FRAG,
      uniforms: { uReveal: { value: 0 }, uLight: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.#fibres = new THREE.LineSegments(new THREE.BufferGeometry(), this.#fibreMaterial);
    this.#fibres.frustumCulled = false;
    this.#fibres.renderOrder = 1;
    this.#scene.add(this.#fibres);

    /* neurons and cores share a shader; the cores are just bigger and paler */
    const glow = (depthTest = true) =>
      new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uBreathe: { value: 0.1 }, uReveal: { value: 0 }, uLight: { value: 0 } },
        transparent: true,
        depthTest,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    this.#neuronMaterial = glow();
    this.#neurons = new THREE.Points(new THREE.BufferGeometry(), this.#neuronMaterial);
    this.#neurons.frustumCulled = false;
    this.#neurons.renderOrder = 2;
    this.#scene.add(this.#neurons);
    // Seen through the tissue: no depth test, and fainter for it.
    this.#deepMaterial = glow(false);
    this.#deepNeurons = new THREE.Points(new THREE.BufferGeometry(), this.#deepMaterial);
    this.#deepNeurons.frustumCulled = false;
    this.#deepNeurons.renderOrder = 2;
    this.#scene.add(this.#deepNeurons);
    this.#coreMaterial = glow();
    this.#cores = new THREE.Points(new THREE.BufferGeometry(), this.#coreMaterial);
    this.#cores.frustumCulled = false;
    this.#cores.renderOrder = 3;
    this.#scene.add(this.#cores);

    /* signals */
    const pulseGeometry = new THREE.BufferGeometry();
    pulseGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY * 3), 3));
    pulseGeometry.setAttribute('aProgress', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY), 1));
    pulseGeometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY * 3), 3));
    pulseGeometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY), 1));
    pulseGeometry.setDrawRange(0, 0);
    this.#pulseMaterial = new THREE.ShaderMaterial({
      vertexShader: PULSE_VERT,
      fragmentShader: PULSE_FRAG,
      uniforms: { uScale: { value: 1 }, uReveal: { value: 0 }, uLight: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.#pulses = new THREE.Points(pulseGeometry, this.#pulseMaterial);
    this.#pulses.frustumCulled = false;
    this.#pulses.renderOrder = 4;
    this.#scene.add(this.#pulses);

    /* halos and names */
    this.#hoverHalo = makeHalo();
    this.#selectHalo = makeHalo();
    this.#scene.add(this.#hoverHalo, this.#selectHalo);
    this.#labelGroup.renderOrder = 6;
    this.#scene.add(this.#labelGroup);

    /* the outside world */
    this.#reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.#controls.autoRotate = !this.#reducedMotion;
    this.#neuronMaterial.uniforms.uBreathe!.value = this.#reducedMotion ? 0 : 0.1;
    this.#deepMaterial.uniforms.uBreathe!.value = this.#reducedMotion ? 0 : 0.1;
    this.#coreMaterial.uniforms.uBreathe!.value = this.#reducedMotion ? 0 : 0.05;

    this.#observer = new ResizeObserver(() => this.#resize());
    this.#observer.observe(mount);
    this.#resize();

    const canvas = this.#renderer.domElement;
    canvas.addEventListener('pointermove', this.#onPointerMove);
    canvas.addEventListener('pointerleave', this.#onPointerLeave);
    canvas.addEventListener('pointerdown', this.#onPointerDown);
    canvas.addEventListener('pointerup', this.#onPointerUp);
    document.addEventListener('visibilitychange', this.#onVisibility);

    this.setPalette(palette);
    this.#frame = requestAnimationFrame(this.#tick);
    void this.#loadModel();
  }

  /**
   * The real brain, once it arrives. "Brain Areas" by Versal (CC-BY 4.0,
   * see `public/models/LICENSE.txt`), Draco-compressed, decoded with the
   * decoder three.js ships. It replaces the formula's mesh and - through
   * the radius table built from its vertices - the surface everything is
   * laid out on, so the neurons sit on real gyri and the fibres follow real
   * sulci. Until it is here, and if it never comes, the formula stands.
   */
  async #loadModel(): Promise<void> {
    try {
      const draco = new DRACOLoader();
      draco.setDecoderPath(DRACO_PATH);
      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);
      // Bytes the hull started fetching while three.js itself was still
      // loading - the usual case - are parsed straight away; otherwise the
      // file is fetched now.
      const bytes = (await this.#modelBytes) ?? null;
      const gltf = bytes ? await loader.parseAsync(bytes, '') : await loader.loadAsync(MODEL_URL);
      draco.dispose();
      if (this.#disposed) return;
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
      });
      const first = meshes[0];
      if (!first) return;
      const geometry = prepareModel(first.geometry);
      this.#surface = surfaceFromGeometry(geometry);
      this.#tissue.geometry.dispose();
      this.#tissue.geometry = geometry;
      this.#tissue.visible = true;
      this.#rebuild();
      this.#resize();
    } catch {
      // No brain to show. The net still surfaces, laid out on the formula.
    } finally {
      this.#modelSettled = true;
    }
  }

  /* ------------------------------- public -------------------------------- */

  /**
   * `graph` is what gets drawn; `atlas` is what decides where. The atlas is
   * the whole unfiltered net, so filtering down to one topic or hiding the
   * sleeping memories removes bodies without moving the ones that stay -
   * a layout computed from the filtered subset alone would spread the
   * survivors out over the freed room and every fibre would jump.
   */
  setGraph(graph: MemoryGraph | null, atlas: MemoryGraph | null = null): void {
    this.#graph = graph;
    this.#atlas = atlas;
    this.#rebuild();
  }

  setPalette(palette: CortexPalette): void {
    this.#palette = palette;
    const light = palette.mode === 'light';
    this.#renderer.toneMapping = light ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1;
    this.#bloom.enabled = !light;
    this.#tissueMaterial.uniforms.uLight!.value = Number(light);
    for (const material of [this.#neuronMaterial, this.#deepMaterial, this.#coreMaterial, this.#fibreMaterial, this.#pulseMaterial]) {
      material.uniforms.uLight!.value = Number(light);
      material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      material.needsUpdate = true;
    }
    for (const halo of [this.#hoverHalo, this.#selectHalo]) {
      halo.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
      halo.material.needsUpdate = true;
    }
    this.#renderer.setClearColor(new THREE.Color(palette.background), 1);
    // A scene background is cleared after the composer binds its linear target.
    this.#scene.background = new THREE.Color(palette.background);
    this.#tissueMaterial.uniforms.uRim!.value.set(palette.mention);
    this.#tissueMaterial.uniforms.uBackground!.value.set(palette.background);
    if (this.#graph) this.#rebuild();
  }

  /** A night is running: the cortex fires more, and in the night's colour. */
  setDreaming(dreaming: boolean): void {
    this.#dreaming = dreaming;
  }

  setSelected(key: string | null): void {
    this.#selected = key;
    this.#placeHalo(this.#selectHalo, key, 1.0);
  }

  /** Flies the camera back to where it started. */
  fit(): void {
    this.view('default');
  }

  /** How far the brain and the net have come up, 0..1 each - for tests and dev tools. */
  get reveal(): { tissue: number; net: number } {
    return { tissue: this.#tissueReveal, net: this.#netReveal };
  }

  /** The tissue's geometry as drawn - for dev tools measuring the model. */
  get tissueGeometry(): THREE.BufferGeometry {
    return this.#tissue.geometry;
  }

  /** Flies the camera to a named side of the brain. */
  view(preset: CortexView): void {
    const to = VIEWS[preset].clone().multiplyScalar(this.#fitDistance());
    this.#flight = {
      from: this.#camera.position.clone(),
      to,
      start: this.#clock.elapsedTime,
      duration: this.#reducedMotion ? 0 : 0.7,
    };
    this.#idleAt = this.#clock.elapsedTime;
  }

  dispose(): void {
    this.#disposed = true;
    cancelAnimationFrame(this.#frame);
    this.#observer.disconnect();
    const canvas = this.#renderer.domElement;
    canvas.removeEventListener('pointermove', this.#onPointerMove);
    canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    canvas.removeEventListener('pointerdown', this.#onPointerDown);
    canvas.removeEventListener('pointerup', this.#onPointerUp);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#controls.dispose();
    this.#clearLabels();
    for (const object of [this.#tissue, this.#neurons, this.#deepNeurons, this.#cores, this.#fibres, this.#pulses]) {
      object.geometry.dispose();
    }
    for (const material of [
      this.#tissueMaterial,
      this.#neuronMaterial,
      this.#deepMaterial,
      this.#coreMaterial,
      this.#fibreMaterial,
      this.#pulseMaterial,
    ]) {
      material.dispose();
    }
    for (const halo of [this.#hoverHalo, this.#selectHalo]) {
      halo.material.map?.dispose();
      halo.material.dispose();
    }
    for (const pass of this.#composer.passes) pass.dispose();
    this.#composer.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
    canvas.remove();
  }

  /* ------------------------------- building ------------------------------ */

  #rebuild(): void {
    const graph = this.#graph;
    const palette = this.#palette;

    /* where things go: from the atlas when there is one, else from the graph itself */
    const surface = this.#surface;
    const placed = layoutCortex(this.#atlas ?? graph, surface);
    const placedEntity = new Map(placed.entities.map((item) => [item.id, item]));
    const placedMemory = new Map(placed.memories.map((item) => [item.id, item]));
    // The atlas is capped like any graph; a body it does not know is placed
    // from the drawn graph instead, so nothing ever goes missing.
    let fallback: ReturnType<typeof layoutCortex> | null = null;
    const fallbackFor = () => (fallback ??= this.#atlas ? layoutCortex(graph, surface) : placed);
    const entityPlaces = (graph?.entities ?? []).map(
      (entity) => placedEntity.get(entity.id) ?? fallbackFor().entities.find((item) => item.id === entity.id)!,
    );
    const memoryPlaces = (graph?.memories ?? []).map(
      (memory) => placedMemory.get(memory.id) ?? fallbackFor().memories.find((item) => item.id === memory.id)!,
    );
    const layout = { entities: entityPlaces, memories: memoryPlaces };

    /* bodies */
    const entityById = new Map(graph?.entities.map((entity) => [entity.id, entity]) ?? []);
    const memoryById = new Map(graph?.memories.map((memory) => [memory.id, memory]) ?? []);

    this.#entityBodies = layout.entities.map((item, index) => {
      const entity = entityById.get(item.id)!;
      return {
        key: 'e:' + item.id,
        type: 'entity' as const,
        id: item.id,
        label: entity.name,
        position: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        // `weight` is 1 + log(1 + mentions): a topic named once is a small
        // pale core, one named twenty times a bright hub. Most topics are
        // the former, and a hundred bright hubs would be a white haze.
        size: 0.045 + Math.min(0.13, (item.weight - 1) * 0.038),
        weight: item.weight,
        region: item.region,
        layer: 'cores' as const,
        slot: index,
      };
    });

    let surfaceSlots = 0;
    let deepSlots = 0;
    this.#memoryBodies = layout.memories.map((item) => {
      const memory = memoryById.get(item.id)!;
      const layer = item.deep ? ('deep' as const) : ('surface' as const);
      return {
        key: 'm:' + item.id,
        type: 'memory' as const,
        id: item.id,
        label: memory.content,
        memoryKind: memory.kind,
        position: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
        size: (0.05 + memory.importance * 0.05 + (memory.pinned ? 0.015 : 0)) * (item.dormant ? 0.7 : 1),
        region: item.region,
        layer,
        slot: item.deep ? deepSlots++ : surfaceSlots++,
      };
    });
    this.#surfaceBodies = this.#memoryBodies.filter((body) => body.layer === 'surface');
    this.#deepBodies = this.#memoryBodies.filter((body) => body.layer === 'deep');

    /* neurons, one cloud on the surface and one inside */
    const clouds = {
      surface: { count: surfaceSlots, position: new Float32Array(surfaceSlots * 3), colour: new Float32Array(surfaceSlots * 3), size: new Float32Array(surfaceSlots), phase: new Float32Array(surfaceSlots) },
      deep: { count: deepSlots, position: new Float32Array(deepSlots * 3), colour: new Float32Array(deepSlots * 3), size: new Float32Array(deepSlots), phase: new Float32Array(deepSlots) },
    };
    const colour = new THREE.Color();
    this.#memoryBodies.forEach((body, index) => {
      const memory = memoryById.get(body.id)!;
      const placed = layout.memories[index]!;
      const cloud = body.layer === 'deep' ? clouds.deep : clouds.surface;
      body.position.toArray(cloud.position, body.slot * 3);
      colour.set(palette.kinds[memory.kind] ?? palette.kinds.fact);
      // Brightness is what importance looks like; a pinned memory burns a
      // little whiter, a sleeping one is an ember, a deep one is seen
      // through the tissue and so a good deal fainter.
      let intensity = palette.mode === 'light' ? 1 : 0.45 + memory.importance * 0.6;
      if (memory.pinned) {
        intensity += 0.3;
        colour.lerp(new THREE.Color('#ffffff'), 0.25);
      }
      if (placed.dormant) {
        if (palette.mode === 'light') colour.lerp(new THREE.Color(palette.background), 0.55);
        else intensity *= 0.28;
      }
      if (placed.deep) intensity *= 0.45;
      colour.multiplyScalar(intensity).toArray(cloud.colour, body.slot * 3);
      cloud.size[body.slot] = body.size;
      cloud.phase[body.slot] = (index * 0.618033) % 1;
    });
    this.#fill(this.#neurons.geometry, clouds.surface.position, clouds.surface.colour, clouds.surface.size, clouds.surface.phase);
    this.#fill(this.#deepNeurons.geometry, clouds.deep.position, clouds.deep.colour, clouds.deep.size, clouds.deep.phase);

    /* cores */
    const coreCount = this.#entityBodies.length;
    const corePosition = new Float32Array(coreCount * 3);
    const coreColour = new Float32Array(coreCount * 3);
    const coreSize = new Float32Array(coreCount);
    const corePhase = new Float32Array(coreCount);
    const entityColour = new THREE.Color(palette.entity);
    for (let index = 0; index < coreCount; index++) {
      const body = this.#entityBodies[index]!;
      body.position.toArray(corePosition, index * 3);
      const intensity = palette.mode === 'light' ? 1 : 0.25 + Math.min(0.45, ((body.weight ?? 1) - 1) * 0.12);
      entityColour.clone().multiplyScalar(intensity).toArray(coreColour, index * 3);
      coreSize[index] = body.size;
      corePhase[index] = (index * 0.618033) % 1;
    }
    this.#fill(this.#cores.geometry, corePosition, coreColour, coreSize, corePhase);

    /* fibres */
    const bodyByKey = new Map<string, Body>();
    for (const body of this.#entityBodies) bodyByKey.set(body.key, body);
    for (const body of this.#memoryBodies) bodyByKey.set(body.key, body);

    const fibres: Fibre[] = [];
    const adjacency = new Map<string, number[]>();
    const attach = (key: string, index: number): void => {
      const list = adjacency.get(key);
      if (list) list.push(index);
      else adjacency.set(key, [index]);
    };
    let vertexCount = 0;
    const mentionColour = new THREE.Color(palette.mention);
    for (const link of graph?.links ?? []) {
      const a = bodyByKey.get('m:' + link.memoryId);
      const b = bodyByKey.get('e:' + link.entityId);
      if (!a || !b) continue;
      const kind = memoryById.get(link.memoryId)?.kind ?? 'fact';
      // A mention is quiet: mostly the tissue's own grey, with a hint of the
      // memory's colour so a cluster is tinted by what it holds. A long one
      // is quieter still - it is the short ones that draw a region.
      const chord = a.position.distanceTo(b.position);
      const tint = palette.mode === 'light' ? mentionColour.clone().lerp(new THREE.Color(palette.kinds[kind]), 0.45) : mentionColour
        .clone()
        .multiplyScalar(0.26 / (1 + chord * 1.5))
        .lerp(new THREE.Color(palette.kinds[kind]), 0.18);
      fibres.push({
        path: fibrePath(a.position, b.position, MENTION_LIFT, MENTION_SEGMENTS, a.key + b.key, surface),
        colour: tint,
        start: vertexCount,
        count: MENTION_SEGMENTS * 2,
        relation: false,
      });
      attach(a.key, fibres.length - 1);
      attach(b.key, fibres.length - 1);
      vertexCount += MENTION_SEGMENTS * 2;
    }
    for (const edge of graph?.edges ?? []) {
      const a = bodyByKey.get('m:' + edge.srcId);
      const b = bodyByKey.get('m:' + edge.dstId);
      if (!a || !b) continue;
      const base = new THREE.Color(palette.relations[edge.relation] ?? palette.mention);
      const span = a.position.distanceTo(b.position);
      const strength =
        (edge.relation === 'contradicts' ? 1.25 : edge.relation === 'co_occurs' ? 0.45 : 0.7 + edge.weight * 0.3) /
        (1 + span * 0.9);
      fibres.push({
        path: fibrePath(a.position, b.position, RELATION_LIFT, RELATION_SEGMENTS, edge.id, surface),
        colour: base.multiplyScalar(palette.mode === 'light' ? 1 : strength * 0.85),
        start: vertexCount,
        count: RELATION_SEGMENTS * 2,
        relation: true,
      });
      attach(a.key, fibres.length - 1);
      attach(b.key, fibres.length - 1);
      vertexCount += RELATION_SEGMENTS * 2;
    }

    const fibrePosition = new Float32Array(vertexCount * 3);
    const fibreColour = new Float32Array(vertexCount * 3);
    const fibreAlong = new Float32Array(vertexCount);
    for (const fibre of fibres) {
      const segments = fibre.count / 2;
      for (let segment = 0; segment < segments; segment++) {
        const at = (fibre.start + segment * 2) * 3;
        const from = segment * 3;
        fibrePosition[at] = fibre.path[from]!;
        fibrePosition[at + 1] = fibre.path[from + 1]!;
        fibrePosition[at + 2] = fibre.path[from + 2]!;
        fibrePosition[at + 3] = fibre.path[from + 3]!;
        fibrePosition[at + 4] = fibre.path[from + 4]!;
        fibrePosition[at + 5] = fibre.path[from + 5]!;
        fibreAlong[fibre.start + segment * 2] = segment / segments;
        fibreAlong[fibre.start + segment * 2 + 1] = (segment + 1) / segments;
      }
      for (let vertex = fibre.start; vertex < fibre.start + fibre.count; vertex++) {
        fibre.colour.toArray(fibreColour, vertex * 3);
      }
    }
    const fibreGeometry = this.#fibres.geometry;
    fibreGeometry.setAttribute('position', new THREE.BufferAttribute(fibrePosition, 3));
    fibreGeometry.setAttribute('aColor', new THREE.BufferAttribute(fibreColour, 3));
    fibreGeometry.setAttribute('aAlong', new THREE.BufferAttribute(fibreAlong, 1));
    fibreGeometry.computeBoundingSphere();
    this.#fibreList = fibres;
    // A copy, not the attribute's own array: `#light` multiplies the base
    // into the attribute, and multiplying the attribute into itself made
    // every hover a little brighter than the one before.
    this.#fibreColours = fibreColour.slice();
    this.#adjacency = adjacency;

    /* signals: reseeded so none is left riding a fibre that is gone */
    this.#pulseList = [];
    this.#pulses.geometry.setDrawRange(0, 0);

    /* names */
    this.#buildLabels();

    /* the first time there is a net, it surfaces; after that it is simply there */
    if (this.#memoryBodies.length || this.#entityBodies.length) this.#netSurfaced = true;

    /* whatever was lit no longer necessarily exists */
    this.#hovered = null;
    this.#hoverHalo.visible = false;
    this.#callbacks.onHover(null);
    this.#placeHalo(this.#selectHalo, this.#selected, 1.0);
  }

  #fill(
    geometry: THREE.BufferGeometry,
    position: Float32Array,
    colour: Float32Array,
    size: Float32Array,
    phase: Float32Array,
  ): void {
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colour, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geometry.setAttribute('aBoost', new THREE.BufferAttribute(new Float32Array(size.length), 1));
    geometry.computeBoundingSphere();
  }

  #clearLabels(): void {
    for (const label of this.#labels) {
      this.#labelGroup.remove(label.sprite);
      label.texture.dispose();
      label.material.dispose();
    }
    this.#labels = [];
  }

  #buildLabels(): void {
    this.#clearLabels();
    const font = getComputedStyle(this.#mount).fontFamily || 'sans-serif';
    const ranked = [...this.#entityBodies].sort((a, b) => b.size - a.size);
    ranked.forEach((body, rank) => {
      const made = makeLabelTexture(body.label, this.#palette.entity, font, this.#palette.mode === 'light');
      if (!made) return;
      const material = new THREE.SpriteMaterial({
        map: made.texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 6;
      this.#labelGroup.add(sprite);
      this.#labels.push({
        sprite,
        texture: made.texture,
        material,
        body,
        dir: body.position.clone().normalize(),
        aspect: made.aspect,
        rank,
        placed: false,
        alpha: 0,
      });
    });
  }

  /* ------------------------------- per frame ----------------------------- */

  readonly #tick = (): void => {
    if (this.#disposed) return;
    this.#frame = requestAnimationFrame(this.#tick);
    if (this.#hidden) return;

    const delta = Math.min(this.#clock.getDelta(), 0.1);
    const time = this.#clock.elapsedTime;

    // The night arrives gradually rather than as a switch flipped.
    const target = this.#dreaming ? 1 : 0;
    this.#dream += (target - this.#dream) * Math.min(1, delta * 1.5);

    this.#neuronMaterial.uniforms.uTime!.value = time;
    this.#deepMaterial.uniforms.uTime!.value = time;
    this.#coreMaterial.uniforms.uTime!.value = time;
    this.#neuronMaterial.uniforms.uBreathe!.value = this.#reducedMotion ? 0 : 0.1 + this.#dream * 0.12;
    this.#bloom.strength = 0.20 + this.#dream * 0.18;

    // First the brain, out of the dark; then, once it is fully there, the
    // net on it. Neither starts before what it needs has arrived.
    const instant = this.#reducedMotion;
    if (this.#modelSettled && this.#tissueReveal < 1) {
      this.#tissueReveal = instant ? 1 : Math.min(1, this.#tissueReveal + delta / TISSUE_REVEAL);
    }
    if (this.#netSurfaced && this.#tissueReveal >= 1 && this.#netReveal < 1) {
      this.#netReveal = instant ? 1 : Math.min(1, this.#netReveal + delta / NET_REVEAL);
    }
    this.#tissueMaterial.uniforms.uReveal!.value = this.#tissueReveal;
    for (const material of [this.#neuronMaterial, this.#deepMaterial, this.#coreMaterial, this.#fibreMaterial, this.#pulseMaterial]) {
      material.uniforms.uReveal!.value = this.#netReveal;
    }
    // At night the tissue itself takes on a little of the dream's colour.
    this.#tissueMaterial.uniforms.uColor!.value
      .set(this.#palette.tissue)
      .multiplyScalar(this.#palette.mode === 'dark' ? ORGAN_GAIN : 1)
      .lerp(new THREE.Color(this.#palette.dream).multiplyScalar(0.6), this.#dream * 0.5);

    if (this.#flight) {
      const flight = this.#flight;
      const progress = flight.duration === 0 ? 1 : Math.min(1, (time - flight.start) / flight.duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      this.#camera.position.lerpVectors(flight.from, flight.to, eased);
      this.#controls.target.set(0, 0, 0);
      if (progress >= 1) this.#flight = null;
    }

    this.#controls.autoRotate = !this.#reducedMotion && time - this.#idleAt > IDLE_RESUME && !this.#flight;
    this.#controls.update();

    this.#stepPulses(delta);
    this.#stepLabels(delta);
    if (this.#pointerDirty) {
      this.#pointerDirty = false;
      this.#pick();
    }
    this.#placeHalo(this.#hoverHalo, this.#hovered, 0.85);
    this.#placeHalo(this.#selectHalo, this.#selected, 1.0);

    this.#composer.render(delta);
  };

  #stepPulses(delta: number): void {
    const fibres = this.#fibreList;
    const geometry = this.#pulses.geometry;
    if (!fibres.length) {
      geometry.setDrawRange(0, 0);
      return;
    }
    const wanted = Math.min(
      PULSE_CAPACITY,
      Math.round(PULSES_AWAKE + (PULSES_DREAMING - PULSES_AWAKE) * this.#dream),
      // A tiny net should not swarm: at most a few signals per fibre.
      fibres.length * 3,
    );
    const list = this.#pulseList;
    while (list.length < wanted) list.push(this.#spawnPulse(Math.random()));
    if (list.length > wanted) list.length = wanted;

    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const progress = geometry.getAttribute('aProgress') as THREE.BufferAttribute;
    const colour = geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const size = geometry.getAttribute('aSize') as THREE.BufferAttribute;
    const speed = (this.#reducedMotion ? 0 : 0.65) * (1 + this.#dream * 0.6);
    const dream = new THREE.Color(this.#palette.dream);
    const tint = new THREE.Color();
    const point: Vec3 = { x: 0, y: 0, z: 0 };

    for (let index = 0; index < list.length; index++) {
      let pulse = list[index]!;
      pulse.t += delta * pulse.speed * speed;
      if (pulse.t >= 1) {
        pulse = this.#spawnPulse(0);
        list[index] = pulse;
      }
      const fibre = fibres[pulse.fibre]!;
      pathPoint(fibre.path, pulse.t, point);
      position.setXYZ(index, point.x, point.y, point.z);
      progress.setX(index, pulse.t);
      // A signal is the fibre's own colour, burning; at night it goes the
      // night's colour instead.
      tint.copy(fibre.colour).multiplyScalar(this.#palette.mode === 'light' ? 0.7 : fibre.relation ? 1.8 : 2.6).lerp(dream, this.#dream * 0.7);
      colour.setXYZ(index, tint.r, tint.g, tint.b);
      size.setX(index, fibre.relation ? 0.075 : 0.05);
    }
    position.needsUpdate = true;
    progress.needsUpdate = true;
    colour.needsUpdate = true;
    size.needsUpdate = true;
    geometry.setDrawRange(0, list.length);
  }

  #spawnPulse(t: number): Pulse {
    const fibres = this.#fibreList;
    // Relations carry more traffic than mentions: they are the night's work.
    let fibre = Math.floor(Math.random() * fibres.length);
    if (!fibres[fibre]!.relation && Math.random() < 0.5) {
      const again = Math.floor(Math.random() * fibres.length);
      if (fibres[again]!.relation) fibre = again;
    }
    return { fibre, t, speed: 0.25 + Math.random() * 0.35 };
  }

  #stepLabels(delta: number): void {
    if (!this.#labels.length) return;
    const camera = this.#camera;
    const distance = camera.position.length();
    const height = this.#mount.clientHeight || 1;
    // A label keeps the same height on screen whatever the zoom.
    const worldPerPixel = (2 * Math.tan((FOV * Math.PI) / 360)) / height;
    const toCamera = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const close = 1 - THREE.MathUtils.smoothstep(distance, 2.2, 2.9);
    const width = this.#mount.clientWidth || 1;
    // Names are placed in rank order, and a name whose box would land on
    // one already placed stays hidden: a region of twelve topics shows the
    // few that matter, not twelve words on top of each other.
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    for (const label of this.#labels) {
      toCamera.copy(camera.position).sub(label.body.position).normalize();
      const facing = label.dir.dot(toCamera);
      const front = THREE.MathUtils.smoothstep(facing, 0.05, 0.45);
      const rank = taken.length < (width < 600 ? 5 : LABEL_RANK_ALWAYS) ? 1 : close;
      let alpha = front * rank;
      const pixels = 13 * (label.rank < 6 ? 1.1 : 1);
      const bodyDistance = camera.position.distanceTo(label.body.position);
      const h = pixels * worldPerPixel * bodyDistance;
      label.sprite.position.copy(label.body.position).addScaledVector(label.dir, label.body.size * 0.5 + h * 0.6);
      if (alpha > 0.02) {
        projected.copy(label.sprite.position).project(camera);
        // A name that holds a place keeps it until another clearly covers
        // it; a name without one waits for clear room. Without that slack
        // two names at the edge of overlap trade places every frame as the
        // brain turns, which reads as flicker.
        const slack = label.placed ? 0.7 : 1.15;
        const box = {
          x: ((projected.x + 1) / 2) * width,
          y: ((1 - projected.y) / 2) * height,
          w: pixels * label.aspect * slack,
          h: pixels * 1.2 * slack,
        };
        const overlaps = taken.some(
          (other) => Math.abs(other.x - box.x) < (other.w + box.w) / 2 && Math.abs(other.y - box.y) < (other.h + box.h) / 2,
        );
        if (overlaps || box.x - box.w / 2 < 8 || box.x + box.w / 2 > width - 8 || box.y < 12 || box.y > height - 12) alpha = 0;
        else taken.push({ ...box, w: pixels * label.aspect, h: pixels * 1.2 });
      }
      label.placed = alpha > 0.02;
      // Names come last in the reveal, once the bodies they name are lit;
      // and they fade rather than snap, in about a fifth of a second.
      const target = alpha * THREE.MathUtils.smoothstep(this.#netReveal, 0.5, 1);
      label.alpha += (target - label.alpha) * Math.min(1, delta * 9);
      label.material.opacity = label.alpha;
      label.sprite.visible = label.alpha > 0.02;
      if (!label.sprite.visible) continue;
      label.sprite.scale.set(h * label.aspect, h, 1);
    }
  }

  #placeHalo(halo: THREE.Sprite, key: string | null, scale: number): void {
    const body = key ? this.#body(key) : null;
    if (!body) {
      halo.visible = false;
      return;
    }
    halo.visible = true;
    halo.position.copy(body.position);
    const diameter = body.size * 1.15 * scale;
    halo.scale.set(diameter, diameter, 1);
    const material = halo.material;
    material.color.set(body.type === 'entity' ? this.#palette.entity : this.#palette.kinds[body.memoryKind ?? 'fact']);
  }

  #body(key: string): Body | null {
    const list = key.startsWith('e:') ? this.#entityBodies : this.#memoryBodies;
    return list.find((body) => body.key === key) ?? null;
  }

  #cloud(layer: Body['layer']): THREE.Points {
    return layer === 'cores' ? this.#cores : layer === 'deep' ? this.#deepNeurons : this.#neurons;
  }

  /* ------------------------------- pointing ------------------------------ */

  readonly #onPointerMove = (event: PointerEvent): void => {
    const box = this.#renderer.domElement.getBoundingClientRect();
    this.#pointer.set(
      ((event.clientX - box.left) / box.width) * 2 - 1,
      -((event.clientY - box.top) / box.height) * 2 + 1,
    );
    this.#pointerDirty = true;
    this.#idleAt = this.#clock.elapsedTime;
  };

  readonly #onPointerLeave = (): void => {
    this.#pointer.set(2, 2);
    this.#pointerDirty = true;
  };

  readonly #onPointerDown = (event: PointerEvent): void => {
    this.#pointerDown = { x: event.clientX, y: event.clientY };
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const down = this.#pointerDown;
    this.#pointerDown = null;
    if (!down) return;
    // A drag turns the brain; only a still press picks something.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    this.#onPointerMove(event);
    this.#pick();
    const hit = this.#hovered ? this.#hit(this.#hovered) : null;
    if (hit) this.#callbacks.onClick(hit);
  };

  readonly #onVisibility = (): void => {
    this.#hidden = document.hidden;
    if (!this.#hidden) this.#clock.getDelta();
  };

  #pick(): void {
    const canvas = this.#renderer.domElement;
    let found: string | null = null;
    if (this.#pointer.x <= 1 && this.#pointer.y <= 1) {
      this.#raycaster.setFromCamera(this.#pointer, this.#camera);
      const distance = this.#camera.position.length();
      // Bodies are picked by their halo, and the halo is a size on screen.
      this.#raycaster.params.Points.threshold = THREE.MathUtils.clamp(0.05 * (distance / CAMERA_DISTANCE), 0.02, 0.09);
      // Where the ray enters the tissue. A body on the surface behind that
      // point is on the far side of the brain: drawn nowhere, so picked
      // nowhere. Bodies inside the brain are drawn through the tissue and
      // stay pickable through it.
      const tissueHit = this.#raycaster.intersectObject(this.#tissue, false)[0];
      const horizon = tissueHit ? tissueHit.distance + 0.06 : Infinity;
      let best: { key: string; score: number } | null = null;
      const consider = (object: THREE.Points, bodies: Body[], weight: number, occluded: boolean): void => {
        if (!bodies.length) return;
        for (const hit of this.#raycaster.intersectObject(object, false)) {
          const body = bodies[hit.index ?? -1];
          if (!body) continue;
          if (occluded && hit.distance > horizon) continue;
          // Nearest to the camera wins.
          const score = hit.distance - weight;
          if (!best || score < best.score) best = { key: body.key, score };
        }
      };
      consider(this.#cores, this.#entityBodies, 0.15, true);
      consider(this.#neurons, this.#surfaceBodies, 0, true);
      consider(this.#deepNeurons, this.#deepBodies, 0, false);
      found = best ? (best as { key: string }).key : null;
    }
    if (found === this.#hovered) return;
    if (this.#hovered) this.#light(this.#hovered, 0);
    this.#hovered = found;
    if (found) this.#light(found, 1);
    canvas.style.cursor = found ? 'pointer' : '';
    this.#callbacks.onHover(found ? this.#hit(found) : null);
  }

  /** Lights a body and every fibre that touches it, or puts them out. */
  #light(key: string, amount: number): void {
    const body = this.#body(key);
    if (body) {
      const boost = this.#cloud(body.layer).geometry.getAttribute('aBoost') as THREE.BufferAttribute;
      boost.setX(body.slot, amount);
      boost.needsUpdate = true;
    }
    const colours = this.#fibres.geometry.getAttribute('aColor') as THREE.BufferAttribute | undefined;
    if (!colours) return;
    // Enough to pick the fibres out of the others, not enough to bloom
    // into a white fan: they are meant to be traced, not to blind.
    const factor = 1 + amount * 1.2;
    for (const fibreIndex of this.#adjacency.get(key) ?? []) {
      const fibre = this.#fibreList[fibreIndex]!;
      for (let vertex = fibre.start; vertex < fibre.start + fibre.count; vertex++) {
        colours.setXYZ(
          vertex,
          this.#fibreColours[vertex * 3]! * factor,
          this.#fibreColours[vertex * 3 + 1]! * factor,
          this.#fibreColours[vertex * 3 + 2]! * factor,
        );
      }
    }
    colours.needsUpdate = true;
  }

  #hit(key: string): CortexHit | null {
    const body = this.#body(key);
    if (!body) return null;
    const projected = body.position.clone().project(this.#camera);
    const box = this.#renderer.domElement.getBoundingClientRect();
    return {
      key: body.key,
      type: body.type,
      id: body.id,
      label: body.label,
      region: REGION_LABEL[body.region],
      ...(body.memoryKind ? { memoryKind: body.memoryKind } : {}),
      x: ((projected.x + 1) / 2) * box.width,
      y: ((1 - projected.y) / 2) * box.height,
    };
  }

  /* -------------------------------- sizing ------------------------------- */

  #fitDistance(): number {
    const bounds = this.#tissue.geometry.boundingSphere;
    const radius = bounds ? bounds.radius + bounds.center.length() + 0.09 : 1.45;
    return cortexCameraDistance(radius, this.#camera.aspect, FOV);
  }

  #resize(): void {
    const width = Math.max(1, this.#mount.clientWidth);
    const height = Math.max(1, this.#mount.clientHeight);
    this.#renderer.setSize(width, height, true);
    this.#composer.setSize(width, height);
    this.#bloom.resolution.set(width, height);
    this.#camera.aspect = width / height;
    // Fit the full rotating organ to whichever dimension is tighter.
    const distance = this.#fitDistance();
    this.#controls.maxDistance = Math.max(9, distance * 1.8);
    this.#camera.position.normalize().multiplyScalar(distance);
    this.#flight = null;
    this.#camera.updateProjectionMatrix();
    // Pixels per world unit at distance one, so sizes can be stated in
    // world units and still come out the same on every screen.
    const scale = (height * this.#renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360));
    for (const material of [this.#neuronMaterial, this.#deepMaterial, this.#coreMaterial, this.#pulseMaterial]) {
      material.uniforms.uScale!.value = scale;
    }
  }
}

/* -------------------------------- geometry ------------------------------- */

/**
 * The loaded model, made ours: centred, turned so the forehead points down
 * +z and the crown up +y like the formula's shape, and scaled so the brain
 * is as long as the formula's. Its vertex colours mark the sulci (that is
 * what the model's author painted red); they become the fold attribute the
 * tissue shader darkens, and the fissure attribute stays zero because the
 * real mesh has the real fissure.
 */
function prepareModel(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone();
  if (MODEL_FRONT < 0) geometry.rotateY(Math.PI);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const centre = box.getCenter(new THREE.Vector3());
  geometry.translate(-centre.x, -centre.y, -centre.z);
  const halfLength = (box.max.z - box.min.z) / 2;
  const scale = MODEL_LENGTH / halfLength;
  geometry.scale(scale, scale, scale);

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  // The brainstem goes. Nothing is laid out on it, and as a thin stalk far
  // from the centre it was where every fibre passing its direction leapt.
  // It is not cut off - that would leave a hole to look into the brain
  // through - but pressed flat up to where the cerebellum begins and drawn
  // in toward its own axis, a small closed base tucked under the cerebellum.
  for (let index = 0; index < position.count; index++) {
    const y = position.getY(index);
    if (y >= BRAINSTEM_BELOW) continue;
    position.setXYZ(
      index,
      position.getX(index) * 0.5,
      BRAINSTEM_BELOW,
      BRAINSTEM_AXIS_Z + (position.getZ(index) - BRAINSTEM_AXIS_Z) * 0.5,
    );
  }
  position.needsUpdate = true;
  const colour = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  const fold = new Float32Array(position.count);
  if (colour) {
    for (let index = 0; index < position.count; index++) {
      const r = colour.getX(index);
      const g = colour.getY(index);
      const b = colour.getZ(index);
      fold[index] = r > 0.5 && r > g * 1.5 && r > b * 1.5 ? -1 : 0;
    }
  }
  geometry.setAttribute('aFold', new THREE.BufferAttribute(fold, 1));
  geometry.setAttribute('aFissure', new THREE.BufferAttribute(new Float32Array(position.count), 1));
  // The pressed base needs normals of its own; the ones that came with the
  // stalk point sideways.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Bake the outer triangle intersections into a radial atlas once at load.
 * Sampling vertices alone leaves holes over broad triangles and misses the base.
 * The grid is a conservative envelope, including the compressed brainstem.
 */
export function surfaceFromGeometry(geometry: THREE.BufferGeometry): Surface {
  const cols = 256, rows = 128;
  const table = new Float32Array(cols * rows);
  const position = geometry.getAttribute('position');
  const indices = geometry.index;
  const directions: THREE.Vector3[] = [];
  for (let row = 0; row < rows; row++) {
    const phi = (row + 0.5) / rows * Math.PI;
    for (let col = 0; col < cols; col++) {
      const theta = ((col + 0.5) / cols - 0.5) * Math.PI * 2;
      directions.push(new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)));
    }
  }
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const uv = vertices.map(() => new THREE.Vector2());
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const edge = new THREE.Vector3();
  for (let i = 0, count = indices?.count ?? position.count; i < count; i += 3) {
    for (let j = 0; j < 3; j++) {
      const p = vertices[j]!.fromBufferAttribute(position, indices ? indices.getX(i + j) : i + j);
      uv[j]!.set(Math.atan2(p.z, p.x) / (2 * Math.PI) + 0.5, Math.acos(THREE.MathUtils.clamp(p.y / p.length(), -1, 1)) / Math.PI);
      if (j > 0) uv[j]!.x -= Math.round(uv[j]!.x - uv[0]!.x);
    }
    ray.direction.set(0, 1, 0);
    const north = ray.intersectTriangle(vertices[0]!, vertices[1]!, vertices[2]!, false, hit) !== null;
    ray.direction.set(0, -1, 0);
    const south = ray.intersectTriangle(vertices[0]!, vertices[1]!, vertices[2]!, false, hit) !== null;
    const minCol = north || south ? 0 : Math.floor(Math.min(...uv.map(p => p.x)) * cols - 0.5);
    const maxCol = north || south ? cols - 1 : Math.ceil(Math.max(...uv.map(p => p.x)) * cols - 0.5);
    // Latitude extrema can lie inside an edge, well beyond its endpoints.
    let minV = Math.min(...uv.map(p => p.y)), maxV = Math.max(...uv.map(p => p.y));
    for (let j = 0; j < 3; j++) {
      const a = vertices[j]!;
      edge.subVectors(vertices[(j + 1) % 3]!, a);
      const ad = a.dot(edge);
      const t = (a.y * ad - edge.y * a.lengthSq()) / (edge.y * ad - a.y * edge.lengthSq());
      if (t > 0 && t < 1) {
        hit.copy(a).addScaledVector(edge, t).normalize();
        const v = Math.acos(THREE.MathUtils.clamp(hit.y, -1, 1)) / Math.PI;
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
    }
    const minRow = north ? 0 : Math.max(0, Math.floor(minV * rows - 0.5));
    const maxRow = south ? rows - 1 : Math.min(rows - 1, Math.ceil(maxV * rows - 0.5));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const at = row * cols + ((col % cols) + cols) % cols;
        ray.direction.copy(directions[at]!);
        if (ray.intersectTriangle(vertices[0]!, vertices[1]!, vertices[2]!, false, hit)) {
          table[at] = Math.max(table[at]!, hit.length());
        }
      }
    }
  }
  // Fill only holes; keep the measured folds instead of blurring away every groove.
  for (let pass = 0; pass < 32; pass++) {
    const before = table.slice();
    let holes = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const at = row * cols + col;
        if (before[at]! > 0) continue;
        let sum = 0, count = 0;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const r = row + dr!;
          if (r < 0 || r >= rows) continue;
          const value = before[r * cols + ((col + dc! + cols) % cols)]!;
          if (value > 0) { sum += value; count++; }
        }
        if (count) table[at] = sum / count;
        else holes++;
      }
    }
    if (!holes) break;
  }
  // A one-cell upper envelope protects silhouettes and the valleys between samples.
  const measured = table.slice();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      for (let dr = -1; dr <= 1; dr++) {
        const r = THREE.MathUtils.clamp(row + dr, 0, rows - 1);
        for (let dc = -1; dc <= 1; dc++) {
          table[row * cols + col] = Math.max(table[row * cols + col]!, measured[r * cols + (col + dc + cols) % cols]!);
        }
      }
    }
  }
  return (dir) => {
    const u = (Math.atan2(dir.z, dir.x) / (Math.PI * 2) + 0.5) * cols - 0.5;
    const v = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1)) / Math.PI * rows - 0.5, 0, rows - 1);
    const c0 = ((Math.floor(u) % cols) + cols) % cols, c1 = (c0 + 1) % cols;
    const r0 = Math.floor(v), r1 = Math.min(rows - 1, r0 + 1);
    const tu = u - Math.floor(u), tv = v - r0;
    const top = table[r0 * cols + c0]! * (1 - tu) + table[r0 * cols + c1]! * tu;
    const bottom = table[r1 * cols + c0]! * (1 - tu) + table[r1 * cols + c1]! * tu;
    // ponytail: a 1.2% guard covers ridges between this 256x128 grid's samples;
    // use an exact surface accelerator if substantially finer geometry is introduced.
    return (top * (1 - tv) + bottom * tv) * 1.012;
  };
}

/* --------------------------------- sprites ------------------------------- */

function makeHalo(): THREE.Sprite {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    context.strokeStyle = 'rgba(255,255,255,0.95)';
    context.lineWidth = 4;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.visible = false;
  sprite.renderOrder = 7;
  return sprite;
}

function makeLabelTexture(
  text: string,
  colour: string,
  font: string,
  light: boolean,
): { texture: THREE.CanvasTexture; aspect: number } | null {
  const ratio = 2;
  const pixels = 26;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  const shown = text.length > 32 ? text.slice(0, 31) + '…' : text;
  context.font = `600 ${pixels * ratio}px ${font}`;
  const width = Math.ceil(context.measureText(shown).width) + 12 * ratio;
  const height = Math.ceil(pixels * 1.5 * ratio);
  canvas.width = width;
  canvas.height = height;
  context.font = `600 ${pixels * ratio}px ${font}`;
  context.textBaseline = 'middle';
  context.textAlign = 'center';
  // A dark rim under the glyphs so the name survives a bright fibre behind it.
  context.shadowColor = light ? 'rgba(255,250,243,0.95)' : 'rgba(0,0,0,0.9)';
  context.shadowBlur = 8 * ratio;
  context.fillStyle = colour;
  context.fillText(shown, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return { texture, aspect: width / height };
}
