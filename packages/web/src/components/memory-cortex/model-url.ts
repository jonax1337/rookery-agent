/**
 * Where the brain model is served from. Its own module so the page chunk can
 * start the fetch without importing `scene.ts` (and with it three.js);
 * `index.html` prefetches the same path.
 */
export const MODEL_URL = '/models/brain.glb';
