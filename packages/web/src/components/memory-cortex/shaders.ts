/**
 * GLSL for the cortex scene: one vertex/fragment pair per drawn layer.
 * `uReveal` runs 0..1 as a layer comes up out of the dark, `uLight` is 1 in
 * the light palette.
 */

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

export const GLOW_VERT = /* glsl */ `
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
export const GLOW_FRAG = /* glsl */ `
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
export const TISSUE_VERT = /* glsl */ `
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

export const TISSUE_FRAG = /* glsl */ `
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
export const FIBRE_VERT = /* glsl */ `
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

export const FIBRE_FRAG = /* glsl */ `
  uniform float uLight;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha * mix(0.48, 0.32, uLight));
  }
`;

export const PULSE_VERT = /* glsl */ `
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

export const PULSE_FRAG = /* glsl */ `
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
