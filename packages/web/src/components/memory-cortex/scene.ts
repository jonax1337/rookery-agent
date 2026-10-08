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
  type CortexEntity,
  type CortexLayout,
  type CortexMemory,
  type CortexRegion,
  type Surface,
  type Vec3,
} from './layout';
import { prepareModel, surfaceFromGeometry } from './brain-model';
import {
  FIBRE_FRAG,
  FIBRE_VERT,
  GLOW_FRAG,
  GLOW_VERT,
  PULSE_FRAG,
  PULSE_VERT,
  TISSUE_FRAG,
  TISSUE_VERT,
} from './shaders';
import { makeHalo, makeLabelTexture } from './sprites';
import { MODEL_URL } from './model-url';

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
 * graph, and calls back on hover and click. `index.tsx` is the hull.
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
/** Narrow stages have room for fewer names. */
const NARROW_STAGE_WIDTH = 600;
const LABEL_RANK_ALWAYS_NARROW = 5;
/** CSS pixels: a name's height on screen, and a little more for the first few. */
const LABEL_PIXELS = 13;
const LABEL_LARGER_RANKS = 6;
const LABEL_LARGER_SCALE = 1.1;
/** A name's box is this much taller than its glyphs. */
const LABEL_BOX_RATIO = 1.2;
/** See `#stepLabels`: a held name needs less room than one waiting for it. */
const LABEL_SLACK_HELD = 0.7;
const LABEL_SLACK_FREE = 1.15;
/** Names stay this far from the stage's edges, in pixels. */
const LABEL_EDGE_X = 8;
const LABEL_EDGE_Y = 12;
const LABEL_SHOWN_ALPHA = 0.02;
const LABEL_FADE_RATE = 9;

/** The Draco decoder is served from here; `index.html` prefetches it. */
const DRACO_PATH = '/draco/';

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
  /** Keys of the two bodies it joins. */
  ends: [string, string];
  /** The points it runs through, flat, on the cortex. */
  path: Float32Array;
  colour: THREE.Color;
  /** First vertex in the merged buffer and how many belong to this fibre. */
  start: number;
  count: number;
  relation: boolean;
}

/** The per-body attributes of one point cloud, one slot per body. */
interface CloudBuffers {
  position: Float32Array;
  colour: Float32Array;
  size: Float32Array;
  phase: Float32Array;
}

type MemoryRecord = MemoryGraph['memories'][number];
type EntityRecord = MemoryGraph['entities'][number];

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
  #layouts = new WeakMap<MemoryGraph, CortexLayout>();
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
  /** Scratch objects for the per-frame passes, so a frame allocates none of its own. */
  readonly #nightTissue = new THREE.Color();
  readonly #pulseNight = new THREE.Color();
  readonly #pulseTint = new THREE.Color();
  readonly #labelToCamera = new THREE.Vector3();
  readonly #labelProjected = new THREE.Vector3();

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
    this.#neuronMaterial = glowMaterial();
    this.#neurons = pointCloud(this.#neuronMaterial, 2);
    // Seen through the tissue: no depth test, and fainter for it.
    this.#deepMaterial = glowMaterial(false);
    this.#deepNeurons = pointCloud(this.#deepMaterial, 2);
    this.#coreMaterial = glowMaterial();
    this.#cores = pointCloud(this.#coreMaterial, 3);

    /* signals */
    this.#pulseMaterial = new THREE.ShaderMaterial({
      vertexShader: PULSE_VERT,
      fragmentShader: PULSE_FRAG,
      uniforms: { uScale: { value: 1 }, uReveal: { value: 0 }, uLight: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.#pulses = pointCloud(this.#pulseMaterial, 4, signalGeometry());
    this.#scene.add(this.#neurons, this.#deepNeurons, this.#cores, this.#pulses);

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
      const mesh = await this.#readBrainMesh();
      if (this.#disposed || !mesh) return;
      this.#adoptBrain(prepareModel(mesh.geometry));
    } catch (error) {
      // No brain to show. The net still surfaces, laid out on the formula.
      console.warn('The brain model could not be used; drawing the formula shape instead.', error);
    } finally {
      this.#modelSettled = true;
    }
  }

  async #readBrainMesh(): Promise<THREE.Mesh | undefined> {
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    try {
      // Bytes the hull started fetching while three.js itself was still
      // loading - the usual case - are parsed straight away; otherwise the
      // file is fetched now.
      const bytes = await this.#modelBytes;
      const gltf = bytes ? await loader.parseAsync(bytes, '') : await loader.loadAsync(MODEL_URL);
      return gltf.scene.getObjectByProperty('isMesh', true) as THREE.Mesh | undefined;
    } finally {
      draco.dispose();
    }
  }

  #adoptBrain(geometry: THREE.BufferGeometry): void {
    this.#surface = surfaceFromGeometry(geometry);
    this.#layouts = new WeakMap();
    this.#tissue.geometry.dispose();
    this.#tissue.geometry = geometry;
    this.#tissue.visible = true;
    this.#rebuild();
    this.#resize();
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
    const layout = this.#layOut(graph);
    const memoryById = new Map(graph?.memories.map((memory) => [memory.id, memory]) ?? []);
    const entityById = new Map(graph?.entities.map((entity) => [entity.id, entity]) ?? []);

    this.#entityBodies = entityBodies(layout.entities, entityById);
    this.#memoryBodies = memoryBodies(layout.memories, memoryById);
    this.#surfaceBodies = this.#memoryBodies.filter((body) => body.layer === 'surface');
    this.#deepBodies = this.#memoryBodies.filter((body) => body.layer === 'deep');
    this.#fillNeurons(layout.memories, memoryById);
    this.#fillCores();
    this.#weaveFibres(graph, memoryById);

    /* signals: reseeded so none is left riding a fibre that is gone */
    this.#pulseList = [];
    this.#pulses.geometry.setDrawRange(0, 0);

    this.#buildLabels();

    /* the first time there is a net, it surfaces; after that it is simply there */
    if (this.#memoryBodies.length || this.#entityBodies.length) this.#netSurfaced = true;

    /* whatever was lit no longer necessarily exists */
    this.#hovered = null;
    this.#hoverHalo.visible = false;
    this.#renderer.domElement.style.cursor = '';
    this.#callbacks.onHover(null);
    this.#placeHalo(this.#selectHalo, this.#selected, 1.0);
  }

  /** Where things go: from the atlas when there is one, else from the graph itself. */
  #layOut(graph: MemoryGraph | null): CortexLayout {
    const placed = this.#layoutOf(this.#atlas ?? graph);
    const placedEntity = new Map(placed.entities.map((item) => [item.id, item]));
    const placedMemory = new Map(placed.memories.map((item) => [item.id, item]));
    // The atlas is capped like any graph; a body it does not know is placed
    // from the drawn graph instead, so nothing ever goes missing.
    let fallback: CortexLayout | null = null;
    const fallbackFor = (): CortexLayout => (fallback ??= this.#atlas ? this.#layoutOf(graph) : placed);
    return {
      entities: (graph?.entities ?? []).map(
        (entity) => placedEntity.get(entity.id) ?? fallbackFor().entities.find((item) => item.id === entity.id)!,
      ),
      memories: (graph?.memories ?? []).map(
        (memory) => placedMemory.get(memory.id) ?? fallbackFor().memories.find((item) => item.id === memory.id)!,
      ),
    };
  }

  /**
   * Laying out is slow and depends only on the graph and the surface, so a
   * repaint in new colours reuses the last result instead of settling the
   * whole net again.
   */
  #layoutOf(graph: MemoryGraph | null): CortexLayout {
    if (!graph) return layoutCortex(null);
    let layout = this.#layouts.get(graph);
    if (!layout) {
      layout = layoutCortex(graph, this.#surface);
      this.#layouts.set(graph, layout);
    }
    return layout;
  }

  /** Neurons: one cloud on the surface and one inside. */
  #fillNeurons(placed: CortexMemory[], memoryById: Map<string, MemoryRecord>): void {
    const surface = cloudBuffers(this.#surfaceBodies.length);
    const deep = cloudBuffers(this.#deepBodies.length);
    this.#memoryBodies.forEach((body, index) => {
      const cloud = body.layer === 'deep' ? deep : surface;
      body.position.toArray(cloud.position, body.slot * 3);
      memoryLight(memoryById.get(body.id)!, placed[index]!, this.#palette).toArray(cloud.colour, body.slot * 3);
      cloud.size[body.slot] = body.size;
      cloud.phase[body.slot] = staggeredPhase(index);
    });
    this.#fill(this.#neurons.geometry, surface);
    this.#fill(this.#deepNeurons.geometry, deep);
  }

  #fillCores(): void {
    const palette = this.#palette;
    const cores = cloudBuffers(this.#entityBodies.length);
    const entityColour = new THREE.Color(palette.entity);
    const tint = new THREE.Color();
    this.#entityBodies.forEach((body, index) => {
      body.position.toArray(cores.position, index * 3);
      const intensity = palette.mode === 'light' ? 1 : 0.25 + Math.min(0.45, ((body.weight ?? 1) - 1) * 0.12);
      tint.copy(entityColour).multiplyScalar(intensity).toArray(cores.colour, index * 3);
      cores.size[index] = body.size;
      cores.phase[index] = staggeredPhase(index);
    });
    this.#fill(this.#cores.geometry, cores);
  }

  /** Every link and relation as a fibre, merged into the one line buffer. */
  #weaveFibres(graph: MemoryGraph | null, memoryById: Map<string, MemoryRecord>): void {
    const bodyByKey = new Map([...this.#entityBodies, ...this.#memoryBodies].map((body) => [body.key, body]));
    const fibres = [...this.#mentionFibres(graph, bodyByKey, memoryById), ...this.#relationFibres(graph, bodyByKey)];
    let vertexCount = 0;
    for (const fibre of fibres) {
      fibre.start = vertexCount;
      vertexCount += fibre.count;
    }

    const buffers = fibreBuffers(fibres, vertexCount);
    const geometry = this.#fibres.geometry;
    // Releases the buffers of the attributes about to be replaced; swapping
    // attributes alone would leave them on the GPU.
    geometry.dispose();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.position, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(buffers.colour, 3));
    geometry.setAttribute('aAlong', new THREE.BufferAttribute(buffers.along, 1));
    geometry.computeBoundingSphere();
    this.#fibreList = fibres;
    // A copy, not the attribute's own array: `#light` multiplies the base
    // into the attribute, and multiplying the attribute into itself made
    // every hover a little brighter than the one before.
    this.#fibreColours = buffers.colour.slice();
    this.#adjacency = adjacencyOf(fibres);
  }

  #mentionFibres(graph: MemoryGraph | null, bodyByKey: Map<string, Body>, memoryById: Map<string, MemoryRecord>): Fibre[] {
    const palette = this.#palette;
    const mentionColour = new THREE.Color(palette.mention);
    const fibres: Fibre[] = [];
    for (const link of graph?.links ?? []) {
      const a = bodyByKey.get('m:' + link.memoryId);
      const b = bodyByKey.get('e:' + link.entityId);
      if (!a || !b) continue;
      const kind = memoryById.get(link.memoryId)?.kind ?? 'fact';
      // A mention is quiet: mostly the tissue's own grey, with a hint of the
      // memory's colour so a cluster is tinted by what it holds. A long one
      // is quieter still - it is the short ones that draw a region.
      const chord = a.position.distanceTo(b.position);
      const kindColour = new THREE.Color(palette.kinds[kind]);
      const tint =
        palette.mode === 'light'
          ? mentionColour.clone().lerp(kindColour, 0.45)
          : mentionColour
              .clone()
              .multiplyScalar(0.26 / (1 + chord * 1.5))
              .lerp(kindColour, 0.18);
      fibres.push({
        ends: [a.key, b.key],
        path: fibrePath(a.position, b.position, MENTION_LIFT, MENTION_SEGMENTS, a.key + b.key, this.#surface),
        colour: tint,
        start: 0,
        count: MENTION_SEGMENTS * 2,
        relation: false,
      });
    }
    return fibres;
  }

  #relationFibres(graph: MemoryGraph | null, bodyByKey: Map<string, Body>): Fibre[] {
    const palette = this.#palette;
    const fibres: Fibre[] = [];
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
        ends: [a.key, b.key],
        path: fibrePath(a.position, b.position, RELATION_LIFT, RELATION_SEGMENTS, edge.id, this.#surface),
        colour: base.multiplyScalar(palette.mode === 'light' ? 1 : strength * 0.85),
        start: 0,
        count: RELATION_SEGMENTS * 2,
        relation: true,
      });
    }
    return fibres;
  }

  #fill(geometry: THREE.BufferGeometry, cloud: CloudBuffers): void {
    // Releases the buffers of the attributes about to be replaced; swapping
    // attributes alone would leave them on the GPU.
    geometry.dispose();
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.position, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(cloud.colour, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(cloud.phase, 1));
    geometry.setAttribute('aBoost', new THREE.BufferAttribute(new Float32Array(cloud.size.length), 1));
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
      .lerp(this.#nightTissue.set(this.#palette.dream).multiplyScalar(0.6), this.#dream * 0.5);

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
    const dream = this.#pulseNight.set(this.#palette.dream);
    const tint = this.#pulseTint;
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
    const toCamera = this.#labelToCamera;
    const projected = this.#labelProjected;
    const height = this.#mount.clientHeight || 1;
    const width = this.#mount.clientWidth || 1;
    // A label keeps the same height on screen whatever the zoom.
    const worldPerPixel = (2 * Math.tan((FOV * Math.PI) / 360)) / height;
    const close = 1 - THREE.MathUtils.smoothstep(camera.position.length(), 2.2, 2.9);
    const alwaysShown = width < NARROW_STAGE_WIDTH ? LABEL_RANK_ALWAYS_NARROW : LABEL_RANK_ALWAYS;
    // Names come last in the reveal, once the bodies they name are lit.
    const surfaced = THREE.MathUtils.smoothstep(this.#netReveal, 0.5, 1);
    // Names are placed in rank order, and a name whose box would land on
    // one already placed stays hidden: a region of twelve topics shows the
    // few that matter, not twelve words on top of each other.
    const taken: ScreenBox[] = [];
    for (const label of this.#labels) {
      toCamera.copy(camera.position).sub(label.body.position).normalize();
      const front = THREE.MathUtils.smoothstep(label.dir.dot(toCamera), 0.05, 0.45);
      let alpha = front * (taken.length < alwaysShown ? 1 : close);
      const pixels = LABEL_PIXELS * (label.rank < LABEL_LARGER_RANKS ? LABEL_LARGER_SCALE : 1);
      const h = pixels * worldPerPixel * camera.position.distanceTo(label.body.position);
      label.sprite.position.copy(label.body.position).addScaledVector(label.dir, label.body.size * 0.5 + h * 0.6);
      if (alpha > LABEL_SHOWN_ALPHA) {
        projected.copy(label.sprite.position).project(camera);
        // A name that holds a place keeps it until another clearly covers
        // it; a name without one waits for clear room. Without that slack
        // two names at the edge of overlap trade places every frame as the
        // brain turns, which reads as flicker.
        const slack = label.placed ? LABEL_SLACK_HELD : LABEL_SLACK_FREE;
        const box = {
          x: ((projected.x + 1) / 2) * width,
          y: ((1 - projected.y) / 2) * height,
          w: pixels * label.aspect * slack,
          h: pixels * LABEL_BOX_RATIO * slack,
        };
        if (taken.some((other) => overlaps(other, box)) || !fitsOnStage(box, width, height)) alpha = 0;
        else taken.push({ ...box, w: pixels * label.aspect, h: pixels * LABEL_BOX_RATIO });
      }
      label.placed = alpha > LABEL_SHOWN_ALPHA;
      // They fade rather than snap, in about a fifth of a second.
      label.alpha += (alpha * surfaced - label.alpha) * Math.min(1, delta * LABEL_FADE_RATE);
      label.material.opacity = label.alpha;
      label.sprite.visible = label.alpha > LABEL_SHOWN_ALPHA;
      if (label.sprite.visible) label.sprite.scale.set(h * label.aspect, h, 1);
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
    const found = this.#bodyUnderPointer();
    if (found === this.#hovered) return;
    if (this.#hovered) this.#light(this.#hovered, 0);
    this.#hovered = found;
    if (found) this.#light(found, 1);
    this.#renderer.domElement.style.cursor = found ? 'pointer' : '';
    this.#callbacks.onHover(found ? this.#hit(found) : null);
  }

  /** The key of the nearest body the pointer is over, if any. */
  #bodyUnderPointer(): string | null {
    if (this.#pointer.x > 1 || this.#pointer.y > 1) return null;
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
    let bestKey: string | null = null;
    let bestScore = Infinity;
    const consider = (object: THREE.Points, bodies: Body[], weight: number, occluded: boolean): void => {
      if (!bodies.length) return;
      for (const hit of this.#raycaster.intersectObject(object, false)) {
        const body = bodies[hit.index ?? -1];
        if (!body) continue;
        if (occluded && hit.distance > horizon) continue;
        // Nearest to the camera wins.
        const score = hit.distance - weight;
        if (score < bestScore) {
          bestScore = score;
          bestKey = body.key;
        }
      }
    };
    consider(this.#cores, this.#entityBodies, 0.15, true);
    consider(this.#neurons, this.#surfaceBodies, 0, true);
    consider(this.#deepNeurons, this.#deepBodies, 0, false);
    return bestKey;
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

/** A name's footprint on the stage: centre and size, in CSS pixels. */
interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
}

function fitsOnStage(box: ScreenBox, width: number, height: number): boolean {
  return (
    box.x - box.w / 2 >= LABEL_EDGE_X &&
    box.x + box.w / 2 <= width - LABEL_EDGE_X &&
    box.y >= LABEL_EDGE_Y &&
    box.y <= height - LABEL_EDGE_Y
  );
}

/** A topic's core: its size says how often it is named. */
function entityBodies(placed: CortexEntity[], entityById: Map<string, EntityRecord>): Body[] {
  return placed.map((item, index): Body => ({
    key: 'e:' + item.id,
    type: 'entity',
    id: item.id,
    label: entityById.get(item.id)!.name,
    position: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
    // `weight` is 1 + log(1 + mentions): a topic named once is a small
    // pale core, one named twenty times a bright hub. Most topics are
    // the former, and a hundred bright hubs would be a white haze.
    size: 0.045 + Math.min(0.13, (item.weight - 1) * 0.038),
    weight: item.weight,
    region: item.region,
    layer: 'cores',
    slot: index,
  }));
}

/** A memory's neuron; `slot` is its index within the cloud of its layer. */
function memoryBodies(placed: CortexMemory[], memoryById: Map<string, MemoryRecord>): Body[] {
  let surfaceSlots = 0;
  let deepSlots = 0;
  return placed.map((item): Body => {
    const memory = memoryById.get(item.id)!;
    return {
      key: 'm:' + item.id,
      type: 'memory',
      id: item.id,
      label: memory.content,
      memoryKind: memory.kind,
      position: new THREE.Vector3(item.position.x, item.position.y, item.position.z),
      size: (0.05 + memory.importance * 0.05 + (memory.pinned ? 0.015 : 0)) * (item.dormant ? 0.7 : 1),
      region: item.region,
      layer: item.deep ? 'deep' : 'surface',
      slot: item.deep ? deepSlots++ : surfaceSlots++,
    };
  });
}

function cloudBuffers(count: number): CloudBuffers {
  return {
    position: new Float32Array(count * 3),
    colour: new Float32Array(count * 3),
    size: new Float32Array(count),
    phase: new Float32Array(count),
  };
}

/** Spreads bodies over 0..1 by the golden ratio, so neighbours do not breathe in step. */
function staggeredPhase(index: number): number {
  return (index * 0.618033) % 1;
}

const WHITE = new THREE.Color('#ffffff');

/**
 * Brightness is what importance looks like; a pinned memory burns a little
 * whiter, a sleeping one is an ember, a deep one is seen through the
 * tissue and so a good deal fainter.
 */
function memoryLight(memory: MemoryRecord, placed: CortexMemory, palette: CortexPalette): THREE.Color {
  const light = palette.mode === 'light';
  const colour = new THREE.Color(palette.kinds[memory.kind] ?? palette.kinds.fact);
  let intensity = light ? 1 : 0.45 + memory.importance * 0.6;
  if (memory.pinned) {
    intensity += 0.3;
    colour.lerp(WHITE, 0.25);
  }
  if (placed.dormant) {
    if (light) colour.lerp(new THREE.Color(palette.background), 0.55);
    else intensity *= 0.28;
  }
  if (placed.deep) intensity *= 0.45;
  return colour.multiplyScalar(intensity);
}

/** The fibres' vertices flattened for the line buffer: two per segment, with how far along its fibre each sits. */
function fibreBuffers(fibres: Fibre[], vertexCount: number): { position: Float32Array; colour: Float32Array; along: Float32Array } {
  const position = new Float32Array(vertexCount * 3);
  const colour = new Float32Array(vertexCount * 3);
  const along = new Float32Array(vertexCount);
  for (const fibre of fibres) {
    const segments = fibre.count / 2;
    for (let segment = 0; segment < segments; segment++) {
      const vertex = fibre.start + segment * 2;
      for (let offset = 0; offset < 6; offset++) position[vertex * 3 + offset] = fibre.path[segment * 3 + offset]!;
      along[vertex] = segment / segments;
      along[vertex + 1] = (segment + 1) / segments;
    }
    for (let vertex = fibre.start; vertex < fibre.start + fibre.count; vertex++) {
      fibre.colour.toArray(colour, vertex * 3);
    }
  }
  return { position, colour, along };
}

/** For each body key, the indices of the fibres that touch it. */
function adjacencyOf(fibres: Fibre[]): Map<string, number[]> {
  const adjacency = new Map<string, number[]>();
  fibres.forEach((fibre, index) => {
    for (const key of fibre.ends) {
      const touching = adjacency.get(key);
      if (touching) touching.push(index);
      else adjacency.set(key, [index]);
    }
  });
  return adjacency;
}

function glowMaterial(depthTest = true): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uBreathe: { value: 0.1 }, uReveal: { value: 0 }, uLight: { value: 0 } },
    transparent: true,
    depthTest,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function pointCloud(material: THREE.ShaderMaterial, renderOrder: number, geometry = new THREE.BufferGeometry()): THREE.Points {
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = renderOrder;
  return points;
}

/** Room for `PULSE_CAPACITY` signals; none drawn until `#stepPulses` says so. */
function signalGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY * 3), 3));
  geometry.setAttribute('aProgress', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY), 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY * 3), 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(PULSE_CAPACITY), 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}
