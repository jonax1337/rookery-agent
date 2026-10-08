import * as THREE from 'three';

/** Canvas-drawn sprites of the cortex: the ring that marks a body and the name floating above a topic. */

const HALO_TEXTURE_SIZE = 128;
const HALO_STROKE = 4;
const HALO_INSET = 6;

const LABEL_FONT_PIXELS = 26;
/** Draw labels at twice their size so they stay crisp when the camera comes close. */
const LABEL_TEXTURE_RATIO = 2;
const LABEL_MAX_CHARACTERS = 32;
const LABEL_PADDING = 12;
const LABEL_LINE_HEIGHT = 1.5;
const LABEL_SHADOW_BLUR = 8;

export interface LabelTexture {
  texture: THREE.CanvasTexture;
  /** Width over height. */
  aspect: number;
}

export function makeHalo(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = HALO_TEXTURE_SIZE;
  canvas.height = HALO_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context) {
    context.strokeStyle = 'rgba(255,255,255,0.95)';
    context.lineWidth = HALO_STROKE;
    context.beginPath();
    context.arc(HALO_TEXTURE_SIZE / 2, HALO_TEXTURE_SIZE / 2, HALO_TEXTURE_SIZE / 2 - HALO_INSET, 0, Math.PI * 2);
    context.stroke();
  }
  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
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

/** Null where the browser has no 2D canvas. */
export function makeLabelTexture(text: string, colour: string, font: string, light: boolean): LabelTexture | null {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  const pixels = LABEL_FONT_PIXELS * LABEL_TEXTURE_RATIO;
  const shown = text.length > LABEL_MAX_CHARACTERS ? text.slice(0, LABEL_MAX_CHARACTERS - 1) + '…' : text;
  const fontSpec = `600 ${pixels}px ${font}`;
  context.font = fontSpec;
  const width = Math.ceil(context.measureText(shown).width) + LABEL_PADDING * LABEL_TEXTURE_RATIO;
  const height = Math.ceil(pixels * LABEL_LINE_HEIGHT);
  // Resizing a canvas resets its context, so the font is set again.
  canvas.width = width;
  canvas.height = height;
  context.font = fontSpec;
  context.textBaseline = 'middle';
  context.textAlign = 'center';
  // A rim under the glyphs so the name survives a bright fibre behind it.
  context.shadowColor = light ? 'rgba(255,250,243,0.95)' : 'rgba(0,0,0,0.9)';
  context.shadowBlur = LABEL_SHADOW_BLUR * LABEL_TEXTURE_RATIO;
  context.fillStyle = colour;
  context.fillText(shown, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return { texture, aspect: width / height };
}
