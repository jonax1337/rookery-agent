import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import type { MemoryGraph, MemoryKind, MemoryRelation } from '@/lib/types';

import { brainShape, fibrePath, layoutCortex, pathPoint, surfaceDust, type Vec3 } from './layout';

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
  varying vec3 vColor;
  ${FACING}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float breathe = 1.0 + uBreathe * sin(uTime * 1.4 + aPhase * 6.2831853);
    float size = aSize * breathe * (1.0 + aBoost * 0.9);
    gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 256.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor * (1.0 + aBoost * 1.0) * facing(position);
  }
`;

/** Five lobes of falloff: a hot pin in the middle, a wide faint halo around it. */
const GLOW_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = pow(max(0.0, 1.0 - d * 10.0), 5.0) * 2.2;
    float hot = pow(max(0.0, 1.0 - d * 6.0), 4.0) * 1.0;
    float mid = pow(max(0.0, 1.0 - d * 3.5), 3.5) * 0.45;
    float halo = pow(max(0.0, 1.0 - d * 2.0), 4.5) * 0.18;
    float outer = pow(max(0.0, 1.0 - d * 1.3), 7.0) * 0.06;
    gl_FragColor = vec4(vColor * (core + hot + mid + halo + outer), 1.0);
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
  varying float vFold;
  varying float vFissure;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = -mv.xyz;
    vFold = aFold;
    vFissure = aFissure;
    gl_Position = projectionMatrix * mv;
  }
`;

const TISSUE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uRim;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vFold;
  varying float vFissure;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vView);
    // The key light sits with the camera, so the brain is always lit from
    // where it is being looked at and never turns its dark side to the viewer.
    vec3 L = normalize(vec3(0.45, 0.8, 0.55));
    float diffuse = max(dot(N, L), 0.0);
    float groove = 1.0 - 0.5 * clamp(-vFold, 0.0, 1.0) - 0.6 * vFissure;
    float ridge = 1.0 + 0.25 * clamp(vFold, 0.0, 1.0);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 colour = uColor * (0.35 + 0.9 * diffuse) * groove * ridge + uRim * fresnel * 0.6;
    gl_FragColor = vec4(colour, 1.0);
  }
`;

const DUST_VERT = /* glsl */ `
  attribute float aPhase;
  attribute float aShade;
  uniform float uTime;
  uniform float uScale;
  uniform float uSize;
  varying float vLight;
  ${FACING}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uSize * uScale / -mv.z, 1.0, 24.0);
    gl_Position = projectionMatrix * mv;
    vLight = aShade * (0.85 + 0.15 * sin(uTime * 0.6 + aPhase * 6.2831853)) * facing(position);
  }
`;

const DUST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vLight;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float soft = pow(max(0.0, 1.0 - d * 2.0), 2.2);
    gl_FragColor = vec4(uColor * soft * vLight, 1.0);
  }
`;

/**
 * Fibres fade out on the far side almost entirely. A neuron seen through
 * the brain is a faint point; a hundred fibres seen through it are a cage,
 * and the cage is what made the old net a ball.
 */
const FIBRE_VERT = /* glsl */ `
  attribute vec3 aColor;
  varying vec3 vColor;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec3 outward = normalize(position);
    vec3 toCamera = normalize(cameraPosition - position);
    float front = 0.04 + 0.96 * smoothstep(-0.1, 0.5, dot(outward, toCamera));
    vColor = aColor * front;
  }
`;

const FIBRE_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

const PULSE_VERT = /* glsl */ `
  attribute float aProgress;
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uScale;
  varying vec3 vColor;
  varying float vProgress;
  ${FACING}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 96.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor * facing(position);
    vProgress = aProgress;
  }
`;

const PULSE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vProgress;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = pow(max(0.0, 1.0 - d * 6.0), 3.0) * 3.0;
    float halo = pow(max(0.0, 1.0 - d * 2.0), 3.0) * 0.6;
    // A signal fades in as it leaves one body and out as it reaches the next.
    float fade = smoothstep(0.0, 0.15, vProgress) * (1.0 - smoothstep(0.82, 1.0, vProgress));
    gl_FragColor = vec4(vColor * (core + halo) * fade, 1.0);
  }
`;

/* ------------------------------- constants ------------------------------- */

const DUST_COUNT = 7000;
/** The tissue token is a dark grey; the dust is many faint additive points of it. */
const TISSUE_GAIN = 0.9;
/** The same token lit as a surface needs headroom for the shading to have anywhere to go. */
const ORGAN_GAIN = 2.4;
const PULSE_CAPACITY = 480;
const PULSES_AWAKE = 110;
const PULSES_DREAMING = 420;
/** Enough steps for a fibre to follow the grooves it crosses. */
const MENTION_SEGMENTS = 18;
const RELATION_SEGMENTS = 28;
/** How far above the tissue a fibre rides, as a share of the radius. */
const MENTION_LIFT = 0.012;
const RELATION_LIFT = 0.03;
const CAMERA_DISTANCE = 3.7;
const FOV = 38;
/** Seconds of stillness before the brain starts turning again. */
const IDLE_RESUME = 6;
/** Labels beyond this rank only appear once the camera comes close. */
const LABEL_RANK_ALWAYS = 22;

/** Three-quarter view from above and in front: both hemispheres, the fissure, the forehead. */
const DEFAULT_CAMERA = new THREE.Vector3(0.7, 0.62, 0.55).normalize().multiplyScalar(CAMERA_DISTANCE);

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
}

/* --------------------------------- scene --------------------------------- */

export class CortexScene {
  readonly #mount: HTMLElement;
  readonly #callbacks: CortexCallbacks;
  #palette: CortexPalette;
  #graph: MemoryGraph | null = null;
  #atlas: MemoryGraph | null = null;

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
  readonly #dust: THREE.Points;
  readonly #dustMaterial: THREE.ShaderMaterial;
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
  #reducedMotion = false;
  #idleAt = 0;
  #frame = 0;
  #disposed = false;
  #pointer = new THREE.Vector2(2, 2);
  #pointerDirty = false;
  #pointerDown: { x: number; y: number } | null = null;
  #hidden = false;
  #flight: { from: THREE.Vector3; to: THREE.Vector3; start: number; duration: number } | null = null;

  constructor(mount: HTMLElement, palette: CortexPalette, callbacks: CortexCallbacks) {
    this.#mount = mount;
    this.#palette = palette;
    this.#callbacks = callbacks;

    // Throws where there is no WebGL - the hull catches it and says so.
    this.#renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 0.9;
    this.#renderer.domElement.style.display = 'block';
    this.#renderer.domElement.style.touchAction = 'none';
    mount.appendChild(this.#renderer.domElement);

    this.#camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 40);
    this.#camera.position.copy(DEFAULT_CAMERA);

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

    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.4, 0.55);
    this.#composer.addPass(this.#bloom);
    this.#composer.addPass(new OutputPass());

    /* the organ itself */
    this.#tissueMaterial = new THREE.ShaderMaterial({
      vertexShader: TISSUE_VERT,
      fragmentShader: TISSUE_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(palette.tissue).multiplyScalar(ORGAN_GAIN) },
        uRim: { value: new THREE.Color(palette.mention) },
      },
    });
    this.#tissue = new THREE.Mesh(buildTissueGeometry(), this.#tissueMaterial);
    this.#tissue.renderOrder = -1;
    this.#scene.add(this.#tissue);

    /* the sparkle on it */
    const dustGeometry = new THREE.BufferGeometry();
    const dust = surfaceDust(DUST_COUNT);
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dust.positions, 3));
    dustGeometry.setAttribute('aShade', new THREE.BufferAttribute(dust.shades, 1));
    const dustPhase = new Float32Array(DUST_COUNT);
    for (let index = 0; index < DUST_COUNT; index++) dustPhase[index] = (index * 0.618033) % 1;
    dustGeometry.setAttribute('aPhase', new THREE.BufferAttribute(dustPhase, 1));
    this.#dustMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 1 },
        uSize: { value: 0.026 },
        uColor: { value: new THREE.Color(palette.tissue).multiplyScalar(TISSUE_GAIN) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.#dust = new THREE.Points(dustGeometry, this.#dustMaterial);
    this.#dust.frustumCulled = false;
    this.#dust.renderOrder = 0;
    this.#scene.add(this.#dust);

    /* fibres */
    this.#fibreMaterial = new THREE.ShaderMaterial({
      vertexShader: FIBRE_VERT,
      fragmentShader: FIBRE_FRAG,
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
        uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uBreathe: { value: 0.1 } },
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
      uniforms: { uScale: { value: 1 } },
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
    this.#renderer.setClearColor(new THREE.Color(palette.background), 1);
    this.#dustMaterial.uniforms.uColor!.value.set(palette.tissue).multiplyScalar(TISSUE_GAIN);
    this.#tissueMaterial.uniforms.uRim!.value.set(palette.mention);
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
    this.#flight = {
      from: this.#camera.position.clone(),
      to: DEFAULT_CAMERA.clone(),
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
    for (const object of [
      this.#tissue,
      this.#dust,
      this.#neurons,
      this.#deepNeurons,
      this.#cores,
      this.#fibres,
      this.#pulses,
    ]) {
      object.geometry.dispose();
    }
    for (const material of [
      this.#tissueMaterial,
      this.#dustMaterial,
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
    const placed = layoutCortex(this.#atlas ?? graph);
    const placedEntity = new Map(placed.entities.map((item) => [item.id, item]));
    const placedMemory = new Map(placed.memories.map((item) => [item.id, item]));
    // The atlas is capped like any graph; a body it does not know is placed
    // from the drawn graph instead, so nothing ever goes missing.
    let fallback: ReturnType<typeof layoutCortex> | null = null;
    const fallbackFor = () => (fallback ??= this.#atlas ? layoutCortex(graph) : placed);
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
      let intensity = 0.45 + memory.importance * 0.6;
      if (memory.pinned) {
        intensity += 0.3;
        colour.lerp(new THREE.Color('#ffffff'), 0.25);
      }
      if (placed.dormant) intensity *= 0.28;
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
      const intensity = 0.25 + Math.min(0.45, ((body.weight ?? 1) - 1) * 0.12);
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
      const tint = mentionColour
        .clone()
        .multiplyScalar(0.26 / (1 + chord * 1.5))
        .lerp(new THREE.Color(palette.kinds[kind]), 0.18);
      fibres.push({
        path: fibrePath(a.position, b.position, MENTION_LIFT, MENTION_SEGMENTS, a.key + b.key),
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
        path: fibrePath(a.position, b.position, RELATION_LIFT, RELATION_SEGMENTS, edge.id),
        colour: base.multiplyScalar(strength),
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
      }
      for (let vertex = fibre.start; vertex < fibre.start + fibre.count; vertex++) {
        fibre.colour.toArray(fibreColour, vertex * 3);
      }
    }
    const fibreGeometry = this.#fibres.geometry;
    fibreGeometry.setAttribute('position', new THREE.BufferAttribute(fibrePosition, 3));
    fibreGeometry.setAttribute('aColor', new THREE.BufferAttribute(fibreColour, 3));
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
      const made = makeLabelTexture(body.label, this.#palette.entity, font);
      if (!made) return;
      const material = new THREE.SpriteMaterial({
        map: made.texture,
        transparent: true,
        depthTest: false,
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
    this.#dustMaterial.uniforms.uTime!.value = time;
    this.#neuronMaterial.uniforms.uBreathe!.value = this.#reducedMotion ? 0 : 0.1 + this.#dream * 0.12;
    this.#bloom.strength = 0.32 + this.#dream * 0.25;
    this.#dustMaterial.uniforms.uColor!.value
      .set(this.#palette.tissue)
      .multiplyScalar(TISSUE_GAIN)
      .lerp(new THREE.Color(this.#palette.dream).multiplyScalar(0.7), this.#dream * 0.6);
    // At night the tissue itself takes on a little of the dream's colour.
    this.#tissueMaterial.uniforms.uColor!.value
      .set(this.#palette.tissue)
      .multiplyScalar(ORGAN_GAIN)
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
    this.#stepLabels();
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
    const speed = (this.#reducedMotion ? 0.35 : 1) * (1 + this.#dream * 0.6);
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
      tint.copy(fibre.colour).multiplyScalar(fibre.relation ? 1.8 : 2.6).lerp(dream, this.#dream * 0.7);
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

  #stepLabels(): void {
    if (!this.#labels.length) return;
    const camera = this.#camera;
    const distance = camera.position.length();
    const height = this.#mount.clientHeight || 1;
    // A label keeps the same height on screen whatever the zoom.
    const worldPerPixel = (2 * Math.tan((FOV * Math.PI) / 360)) / height;
    const toCamera = new THREE.Vector3();
    const close = THREE.MathUtils.smoothstep(distance, 2.9, 2.2);
    for (const label of this.#labels) {
      toCamera.copy(camera.position).sub(label.body.position).normalize();
      const facing = label.dir.dot(toCamera);
      const front = THREE.MathUtils.smoothstep(facing, 0.05, 0.45);
      const rank = label.rank < LABEL_RANK_ALWAYS ? 1 : close;
      const alpha = front * rank;
      label.material.opacity = alpha;
      label.sprite.visible = alpha > 0.02;
      if (!label.sprite.visible) continue;
      const pixels = 13 * (label.rank < 6 ? 1.1 : 1);
      const bodyDistance = camera.position.distanceTo(label.body.position);
      const h = pixels * worldPerPixel * bodyDistance;
      label.sprite.scale.set(h * label.aspect, h, 1);
      label.sprite.position.copy(label.body.position).addScaledVector(label.dir, label.body.size * 0.5 + h * 0.6);
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
      ...(body.memoryKind ? { memoryKind: body.memoryKind } : {}),
      x: ((projected.x + 1) / 2) * box.width,
      y: ((1 - projected.y) / 2) * box.height,
    };
  }

  /* -------------------------------- sizing ------------------------------- */

  #resize(): void {
    const width = Math.max(1, this.#mount.clientWidth);
    const height = Math.max(1, this.#mount.clientHeight);
    this.#renderer.setSize(width, height, true);
    this.#composer.setSize(width, height);
    this.#bloom.resolution.set(width, height);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    // Pixels per world unit at distance one, so sizes can be stated in
    // world units and still come out the same on every screen.
    const scale = (height * this.#renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360));
    for (const material of [
      this.#neuronMaterial,
      this.#deepMaterial,
      this.#coreMaterial,
      this.#dustMaterial,
      this.#pulseMaterial,
    ]) {
      material.uniforms.uScale!.value = scale;
    }
  }
}

/* -------------------------------- geometry ------------------------------- */

/**
 * A sphere pushed out to the brain's radius in every direction, with the
 * fold and fissure of each vertex kept as attributes for the shader to
 * shade. The normals come from the displaced positions, which is what makes
 * the ridges catch the light.
 */
function buildTissueGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 192, 128);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const fold = new Float32Array(position.count);
  const fissure = new Float32Array(position.count);
  const dir = new THREE.Vector3();
  for (let index = 0; index < position.count; index++) {
    dir.fromBufferAttribute(position, index).normalize();
    const shape = brainShape(dir);
    position.setXYZ(index, dir.x * shape.radius, dir.y * shape.radius, dir.z * shape.radius);
    fold[index] = shape.fold;
    fissure[index] = shape.fissure;
  }
  position.needsUpdate = true;
  geometry.setAttribute('aFold', new THREE.BufferAttribute(fold, 1));
  geometry.setAttribute('aFissure', new THREE.BufferAttribute(fissure, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
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
    depthTest: false,
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
  context.shadowColor = 'rgba(0,0,0,0.9)';
  context.shadowBlur = 8 * ratio;
  context.fillStyle = colour;
  context.fillText(shown, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return { texture, aspect: width / height };
}
