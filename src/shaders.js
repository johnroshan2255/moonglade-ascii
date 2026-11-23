// All shaders, written twice: GLSL (WebGL2) and WGSL (WebGPU, no runtime transpiler needed).
//
// Pipeline:
//   1. scene pass   -> low-res RT (one texel per glyph cell, or 2x2 when supersampling)
//                      rgb = lit colour, a = (class * 32 + sub) / 255  (glyph family + variant)
//   2. reflect pass -> low-res RT seen from a mirrored camera, sampled by the water shader
//   3. cell pass    -> runs once per glyph cell: picks the glyph index + colour (edge detect etc.)
//   4. composite    -> full resolution: 2 texel fetches per pixel (cell + glyph atlas)
//
// All render targets use RENDERTARGET_ORIGIN_BOTTOM so memory row 0 is the bottom of the image on
// both backends; that lets every pass address texels with integer fragment coordinates.

import * as pc from 'playcanvas';

export const CLS = { EMPTY: 0, GROUND: 1, GRASS: 2, FOLIAGE: 3, STONE: 4, WATER: 5, CHAR: 6, GLOW: 7 };

// Glyph families. Ramps go dark -> bright.
const SETS = [
  ['blank', ' '],
  ['ground', ' .,:;+*ox%#'],
  ['grass', '\\`(|!i/\')'], // sub 0-2 lean left | 3-5 upright | 6-8 lean right
  ['grassDim', ' .,'],
  ['foliage', ' .:oadbQ08@'],
  ['stone', ' .:-=x#HBWM'],
  ['water', ' .-~=oO0@'],
  ['char', ' .:-+=xX%#@'],
  ['glow', ' .\'*+oO@'],
  ['edge', '|-/\\'],
  ['haze', ' .,:-=+*'],
];

export const GLYPHS = (() => {
  let chars = '';
  const off = {};
  for (const [k, s] of SETS) {
    off[k] = [chars.length, s.length];
    chars += s;
  }
  return { chars, off };
})();

const O = GLYPHS.off;
const RAMPS = [
  [CLS.GROUND, 'ground'], [CLS.FOLIAGE, 'foliage'], [CLS.STONE, 'stone'],
  [CLS.WATER, 'water'], [CLS.CHAR, 'char'], [CLS.GLOW, 'glow'],
];
const rampIfs = (lang) => RAMPS.map(([cls, key], i) => {
  const [o, n] = O[key];
  const kw = i === 0 ? 'if' : 'else if';
  return lang === 'glsl'
    ? `${kw} (cls == ${cls}) { ro = ${o}; rn = ${n}; }`
    : `${kw} (cls == ${cls}) { ro = ${o}; rn = ${n}; }`;
}).join('\n    ');

const f = (n) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

// ---------------------------------------------------------------- shared snippets
const HASH_GLSL = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;
const HASH_WGSL = `
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + vec3f(dot(p3, p3.yzx + vec3f(33.33)));
  return fract((p3.x + p3.y) * p3.z);
}`;

// Wind "gust" field shared by terrain and grass so strokes lean together.
const GRASS_GLSL = `
float grassSub(vec3 w, float t) {
  float lean = sin(t * 1.3 + w.x * 0.22 + w.z * 0.17) + 0.6 * sin(t * 2.3 - w.z * 0.31 + w.x * 0.07);
  float l = lean < -0.55 ? 0.0 : (lean > 0.55 ? 2.0 : 1.0);
  float v = min(floor(hash12(floor(w.xz * 2.5)) * 3.0), 2.0);
  return l * 3.0 + v;
}`;
const GRASS_WGSL = `
fn grassSub(w: vec3f, t: f32) -> f32 {
  let lean = sin(t * 1.3 + w.x * 0.22 + w.z * 0.17) + 0.6 * sin(t * 2.3 - w.z * 0.31 + w.x * 0.07);
  let l = select(select(1.0, 2.0, lean > 0.55), 0.0, lean < -0.55);
  let v = min(floor(hash12(floor(w.xz * 2.5)) * 3.0), 2.0);
  return l * 3.0 + v;
}`;

// ---------------------------------------------------------------- world (lit) shader
// Vertex colour alpha packs (class * 32 + swayWeight * 31) so one mesh can hold several glyph
// families (e.g. tree trunk + canopy) and still be a single draw call.
function worldVS_GLSL({ inst, push, fly }) {
  return `
attribute vec3 vertex_position;
attribute vec3 vertex_normal;
attribute vec4 vertex_color;
${inst ? 'attribute vec4 inst0;\nattribute vec4 inst1;' : ''}
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform float uTime;
uniform float uSway;
uniform vec3 uPlayer;
uniform vec3 uPush0;
uniform vec3 uPush1;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vCls;
varying float vGlow;
void main(void) {
  vec3 p = vertex_position;
  vec3 n = vertex_normal;
  vec3 col = vertex_color.rgb;
  float code = floor(vertex_color.a * 255.0 + 0.5);
  float cls = floor(code / 32.0);
  float sw = (code - cls * 32.0) / 31.0;
  float seed = 0.0;
  float glow = 1.0;
${inst ? `
  float cr = cos(inst1.x);
  float sr = sin(inst1.x);
  p = vec3(cr * p.x + sr * p.z, p.y, -sr * p.x + cr * p.z) * inst0.w;
  n = vec3(cr * n.x + sr * n.z, n.y, -sr * n.x + cr * n.z);
  col *= inst1.y;
  seed = inst1.z;` : ''}
  vec4 wp = matrix_model * vec4(p, 1.0);
${inst ? '  wp.xyz += inst0.xyz;' : ''}
${fly ? `
  float t = uTime;
  wp.xyz += vec3(sin(t * 0.37 + seed * 17.0) * 1.8 + sin(t * 1.1 + seed * 5.0) * 0.3,
                 sin(t * 0.6 + seed * 11.0) * 0.6,
                 cos(t * 0.29 + seed * 23.0) * 1.8);
  glow = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(t * (0.6 + seed) + seed * 40.0), 3.0);` : ''}
  float w = sw * sw * uSway;
  float ph = uTime * 1.6 + wp.x * 0.21 + wp.z * 0.17 + seed * 6.2831;
  wp.x += sin(ph) * w;
  wp.z += cos(ph * 0.8 + 1.7) * w * 0.6;
${push ? ['uPlayer', 'uPush0', 'uPush1'].map((u) => `
  {
    vec2 d = wp.xz - ${u}.xz;
    float dl = length(d) + 0.0001;
    float k = clamp(1.0 - dl / 1.3, 0.0, 1.0) * sw;
    wp.xz += d / dl * k * 0.55;
    wp.y -= k * 0.25;
  }`).join('') : ''}
  vWorld = wp.xyz;
  vNormal = mat3(matrix_model) * n;
  vColor = col;
  vCls = cls;
  vGlow = glow;
  gl_Position = matrix_viewProjection * wp;
}`;
}

function worldVS_WGSL({ inst, push, fly }) {
  return `
attribute vertex_position: vec3f;
attribute vertex_normal: vec3f;
attribute vertex_color: vec4f;
${inst ? 'attribute inst0: vec4f;\nattribute inst1: vec4f;' : ''}
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
uniform uTime: f32;
uniform uSway: f32;
uniform uPlayer: vec3f;
uniform uPush0: vec3f;
uniform uPush1: vec3f;
varying vWorld: vec3f;
varying vNormal: vec3f;
varying vColor: vec3f;
varying vCls: f32;
varying vGlow: f32;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  var p = input.vertex_position;
  var n = input.vertex_normal;
  var col = input.vertex_color.rgb;
  let code = floor(input.vertex_color.a * 255.0 + 0.5);
  let cls = floor(code / 32.0);
  let sw = (code - cls * 32.0) / 31.0;
  var seed = 0.0;
  var glow = 1.0;
${inst ? `
  let cr = cos(input.inst1.x);
  let sr = sin(input.inst1.x);
  p = vec3f(cr * p.x + sr * p.z, p.y, -sr * p.x + cr * p.z) * input.inst0.w;
  n = vec3f(cr * n.x + sr * n.z, n.y, -sr * n.x + cr * n.z);
  col = col * input.inst1.y;
  seed = input.inst1.z;` : ''}
  var wp = uniform.matrix_model * vec4f(p, 1.0);
${inst ? '  wp = vec4f(wp.xyz + input.inst0.xyz, 1.0);' : ''}
${fly ? `
  let t = uniform.uTime;
  wp = vec4f(wp.xyz + vec3f(sin(t * 0.37 + seed * 17.0) * 1.8 + sin(t * 1.1 + seed * 5.0) * 0.3,
                            sin(t * 0.6 + seed * 11.0) * 0.6,
                            cos(t * 0.29 + seed * 23.0) * 1.8), 1.0);
  glow = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(t * (0.6 + seed) + seed * 40.0), 3.0);` : ''}
  let w = sw * sw * uniform.uSway;
  let ph = uniform.uTime * 1.6 + wp.x * 0.21 + wp.z * 0.17 + seed * 6.2831;
  wp.x = wp.x + sin(ph) * w;
  wp.z = wp.z + cos(ph * 0.8 + 1.7) * w * 0.6;
${push ? ['uPlayer', 'uPush0', 'uPush1'].map((u) => `
  {
    let d = wp.xz - uniform.${u}.xz;
    let dl = length(d) + 0.0001;
    let k = clamp(1.0 - dl / 1.3, 0.0, 1.0) * sw;
    wp.x = wp.x + d.x / dl * k * 0.55;
    wp.z = wp.z + d.y / dl * k * 0.55;
    wp.y = wp.y - k * 0.25;
  }`).join('') : ''}
  let m = uniform.matrix_model;
  output.vWorld = wp.xyz;
  output.vNormal = mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * n;
  output.vColor = col;
  output.vCls = cls;
  output.vGlow = glow;
  output.position = uniform.matrix_viewProjection * wp;
  return output;
}`;
}

const FOG_GLSL = `
// distance haze (exp^2, fades to the pale haze colour) + low ground mist
float fogAmount(vec3 w, vec3 eye) {
  float d = length(w - eye);
  float t = max(d - uFog.x, 0.0) / max(uFog.y - uFog.x, 0.001) * 1.8;
  float fd = 1.0 - exp(-t * t);
  float mist = uFog.z * exp(-max(w.y, 0.0) * uFog.w) * smoothstep(2.0, 16.0, d);
  return clamp(fd + mist * (1.0 - fd), 0.0, 1.0);
}`;
const FOG_WGSL = `
fn fogAmount(w: vec3f, eye: vec3f) -> f32 {
  let d = length(w - eye);
  let t = max(d - uniform.uFog.x, 0.0) / max(uniform.uFog.y - uniform.uFog.x, 0.001) * 1.8;
  let fd = 1.0 - exp(-t * t);
  let mist = uniform.uFog.z * exp(-max(w.y, 0.0) * uniform.uFog.w) * smoothstep(2.0, 16.0, d);
  return clamp(fd + mist * (1.0 - fd), 0.0, 1.0);
}`;

// The alpha byte carries (class * 32 + sub). For grass/water sub is the stroke / reflection
// variant; for every other class sub = fog * 31 so the ASCII pass can draw haze cells.
const WORLD_FS_GLSL = `
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec4 uLantern;
uniform vec3 uLanternCol;
uniform vec3 uPlayer;
uniform vec4 uFog;
uniform vec3 uHaze;
uniform vec3 view_position;
uniform float uTime;
uniform float uEmissive;
uniform float uNearFade;
uniform vec4 uRing0;
uniform vec4 uRing1;
uniform vec4 uRing2;
uniform float uRingGain;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vCls;
varying float vGlow;
${HASH_GLSL}
${GRASS_GLSL}
${FOG_GLSL}
void main(void) {
  float camD = length(vWorld - view_position);
  if (camD < uNearFade && hash12(floor(gl_FragCoord.xy)) > (camD - 1.0) / (uNearFade - 1.0)) discard;
  vec3 n = normalize(vNormal);
  vec3 V = normalize(view_position - vWorld);
  if (dot(n, V) < 0.0) n = -n; // two-sided surfaces (wings, cloth) light from the side we see
  vec3 light = uMoonCol * max(dot(n, uMoonDir), 0.0) + mix(uGroundAmb, uSkyAmb, n.y * 0.5 + 0.5);
  vec3 tl = uLantern.xyz - vWorld;
  float dl = max(length(tl), 0.001);
  float att = clamp(1.0 - dl / uLantern.w, 0.0, 1.0);
  att *= att;
  light += uLanternCol * att * (0.35 + 0.65 * max(dot(n, tl / dl), 0.0));
  if (vWorld.y < uPlayer.y + 0.08) {
    float sd = length(vWorld.xz - uPlayer.xz);
    light *= mix(0.25, 1.0, smoothstep(0.15, 0.7, sd));
  }
  vec3 c = vColor * light + vColor * (uEmissive * vGlow);
  // sound rings (staff strikes, chimes, the warden's footfalls)
  float rg = 0.0;
  rg += (1.0 - smoothstep(0.0, 0.45, abs(length(vWorld.xz - uRing0.xy) - uRing0.z))) * uRing0.w;
  rg += (1.0 - smoothstep(0.0, 0.45, abs(length(vWorld.xz - uRing1.xy) - uRing1.z))) * uRing1.w;
  rg += (1.0 - smoothstep(0.0, 0.45, abs(length(vWorld.xz - uRing2.xy) - uRing2.z))) * uRing2.w;
  c += vec3(0.6, 0.52, 0.4) * rg * uRingGain;
  // fog-lit rim: silhouettes pick up the haze on their edges (the soft halo of the genre)
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  c += uHaze * rim * 0.22;
  float fog = fogAmount(vWorld, view_position);
  // emissive things punch through the haze a little
  fog *= 1.0 - clamp(uEmissive * 0.25, 0.0, 0.6);
  c = mix(c, uHaze, fog);
  float cls = floor(vCls + 0.5);
  float sub = floor(fog * 31.0 + 0.5);
  if (cls == 2.0) {
    if (fog > 0.5) cls = 1.0; else sub = grassSub(vWorld, uTime);
  }
  gl_FragColor = vec4(c, (cls * 32.0 + sub) / 255.0);
}`;

const WORLD_FS_WGSL = `
uniform uMoonDir: vec3f;
uniform uMoonCol: vec3f;
uniform uSkyAmb: vec3f;
uniform uGroundAmb: vec3f;
uniform uLantern: vec4f;
uniform uLanternCol: vec3f;
uniform uPlayer: vec3f;
uniform uFog: vec4f;
uniform uHaze: vec3f;
uniform view_position: vec3f;
uniform uTime: f32;
uniform uEmissive: f32;
uniform uNearFade: f32;
uniform uRing0: vec4f;
uniform uRing1: vec4f;
uniform uRing2: vec4f;
uniform uRingGain: f32;
varying vWorld: vec3f;
varying vNormal: vec3f;
varying vColor: vec3f;
varying vCls: f32;
varying vGlow: f32;
${HASH_WGSL}
${GRASS_WGSL}
${FOG_WGSL}
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let camD = length(input.vWorld - uniform.view_position);
  if (camD < uniform.uNearFade && hash12(floor(input.position.xy)) > (camD - 1.0) / (uniform.uNearFade - 1.0)) { discard; }
  var n = normalize(input.vNormal);
  let V = normalize(uniform.view_position - input.vWorld);
  if (dot(n, V) < 0.0) { n = -n; }
  var light = uniform.uMoonCol * max(dot(n, uniform.uMoonDir), 0.0) + mix(uniform.uGroundAmb, uniform.uSkyAmb, n.y * 0.5 + 0.5);
  let tl = uniform.uLantern.xyz - input.vWorld;
  let dl = max(length(tl), 0.001);
  var att = clamp(1.0 - dl / uniform.uLantern.w, 0.0, 1.0);
  att = att * att;
  light = light + uniform.uLanternCol * att * (0.35 + 0.65 * max(dot(n, tl / dl), 0.0));
  if (input.vWorld.y < uniform.uPlayer.y + 0.08) {
    let sd = length(input.vWorld.xz - uniform.uPlayer.xz);
    light = light * mix(0.25, 1.0, smoothstep(0.15, 0.7, sd));
  }
  var c = input.vColor * light + input.vColor * (uniform.uEmissive * input.vGlow);
  var rg = 0.0;
  rg = rg + (1.0 - smoothstep(0.0, 0.45, abs(length(input.vWorld.xz - uniform.uRing0.xy) - uniform.uRing0.z))) * uniform.uRing0.w;
  rg = rg + (1.0 - smoothstep(0.0, 0.45, abs(length(input.vWorld.xz - uniform.uRing1.xy) - uniform.uRing1.z))) * uniform.uRing1.w;
  rg = rg + (1.0 - smoothstep(0.0, 0.45, abs(length(input.vWorld.xz - uniform.uRing2.xy) - uniform.uRing2.z))) * uniform.uRing2.w;
  c = c + vec3f(0.6, 0.52, 0.4) * rg * uniform.uRingGain;
  let rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  c = c + uniform.uHaze * rim * 0.22;
  var fog = fogAmount(input.vWorld, uniform.view_position);
  fog = fog * (1.0 - clamp(uniform.uEmissive * 0.25, 0.0, 0.6));
  c = mix(c, uniform.uHaze, fog);
  var cls = floor(input.vCls + 0.5);
  var sub = floor(fog * 31.0 + 0.5);
  if (cls == 2.0) {
    if (fog > 0.5) { cls = 1.0; } else { sub = grassSub(input.vWorld, uniform.uTime); }
  }
  output.color = vec4f(c, (cls * 32.0 + sub) / 255.0);
  return output;
}`;

// ---------------------------------------------------------------- water
const WATER_VS_GLSL = `
attribute vec3 vertex_position;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec3 vWorld;
void main(void) {
  vec4 wp = matrix_model * vec4(vertex_position, 1.0);
  vWorld = wp.xyz;
  gl_Position = matrix_viewProjection * wp;
}`;
const WATER_VS_WGSL = `
attribute vertex_position: vec3f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
varying vWorld: vec3f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let wp = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
  output.vWorld = wp.xyz;
  output.position = uniform.matrix_viewProjection * wp;
  return output;
}`;

const WATER_FS_GLSL = `
uniform sampler2D uRefl;
uniform vec2 uRtSize;
uniform float uReflOn;
uniform vec3 uMoonSky;
uniform vec3 view_position;
uniform float uTime;
uniform vec3 uPlayer;
uniform float uWet;
uniform vec4 uFog;
uniform vec3 uHaze;
uniform vec4 uLantern;
uniform vec3 uLanternCol;
uniform vec3 uPond;
uniform vec4 uMire;
varying vec3 vWorld;
${HASH_GLSL}
${FOG_GLSL}
void main(void) {
  vec2 q = vWorld.xz;
  float dp = length(q - uPlayer.xz);
  float ring = sin(dp * 7.0 - uTime * 5.0) * exp(-dp * 0.6) * uWet;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float t = uTime * 0.35 + fi * 0.333;
    float cyc = floor(t);
    float ph = t - cyc;
    vec2 c = uPond.xy + (vec2(hash12(vec2(cyc, fi)), hash12(vec2(fi, cyc + 7.0))) - 0.5) * uPond.z * 1.2;
    float d = length(q - c);
    ring += sin(d * 10.0 - ph * 12.0) * (1.0 - ph) * step(d, ph * 3.0) * exp(-d * 0.8);
  }
  vec2 mq = q - uMire.xy;
  float md = length(mq);
  ring += sin(md * 8.0 - uTime * 9.0) * exp(-md * 0.35) * uMire.w * 0.7;
  float waves = sin(q.x * 0.9 + uTime * 0.7) * 0.5 + sin(q.y * 1.3 - uTime * 0.9) * 0.5;
  vec3 nrm = normalize(vec3(ring * 0.25 + waves * 0.04, 1.0, ring * 0.25 + waves * 0.03));
  vec3 vd = normalize(vWorld - view_position);
  vec3 r = reflect(vd, nrm);

  // faked sky: the pale haze itself, a cold moon disc and a few stars
  float m = max(dot(r, uMoonSky), 0.0);
  float moon = smoothstep(0.9978, 0.9987, m);
  float halo = pow(m, 60.0) * 0.25;
  vec2 sp = floor(r.xz / max(r.y, 0.05) * 18.0);
  float star = step(0.99, hash12(sp)) * (0.5 + 0.5 * sin(uTime * 3.0 + hash12(sp + 3.1) * 40.0));
  vec3 sky = uHaze * 0.8 + vec3(0.95) * (moon * 1.4 + halo) + vec3(0.5) * star * 0.25;
  float sub = moon > 0.5 ? 2.0 : 0.0;

  // reflected objects come back as dark silhouettes (rigid mirror camera => flip x)
  vec2 uv = gl_FragCoord.xy / uRtSize;
  vec4 rc = texture2D(uRefl, vec2(1.0 - uv.x, uv.y) + nrm.xz * 0.03);
  float hasObj = step(0.01, rc.a) * uReflOn;
  vec3 col = mix(sky, rc.rgb * 0.6, hasObj);
  if (hasObj > 0.5) sub = 1.0;

  float fres = mix(0.45, 0.95, pow(1.0 - abs(vd.y), 2.0));
  col = vec3(0.008, 0.024, 0.02) + col * fres;
  // bloated pale body with dozens of hair-thin arms, just beneath the surface
  float mbody = 1.0 - smoothstep(uMire.z * 0.3, uMire.z * 0.6, md);
  float mang = atan(mq.y, mq.x);
  float marms = pow(abs(sin(mang * 13.0 + sin(md * 1.3 - uTime * 0.8) * 1.5)), 40.0) * (1.0 - smoothstep(uMire.z * 0.35, uMire.z * 1.3, md));
  float mire = clamp(mbody * 0.9 + marms * 0.8, 0.0, 1.0) * uMire.w;
  // a dark, bloated shape beneath the bright mirror: unmistakably something huge down there
  col = mix(col, vec3(0.035, 0.037, 0.04), mire * 0.92);
  vec3 tl = uLantern.xyz - vWorld;
  float att = clamp(1.0 - length(tl) / uLantern.w, 0.0, 1.0);
  col += uLanternCol * att * att * 0.3;
  float fog = fogAmount(vWorld, view_position);
  col = mix(col, uHaze, fog);
  float cls = ${f(CLS.WATER)};
  if (fog > 0.5) { cls = ${f(CLS.GROUND)}; sub = floor(fog * 31.0 + 0.5); }
  gl_FragColor = vec4(col, (cls * 32.0 + sub) / 255.0);
}`;

const WATER_FS_WGSL = `
var uRefl: texture_2d<f32>;
var uRefl_sampler: sampler;
uniform uRtSize: vec2f;
uniform uReflOn: f32;
uniform uMoonSky: vec3f;
uniform view_position: vec3f;
uniform uTime: f32;
uniform uPlayer: vec3f;
uniform uWet: f32;
uniform uFog: vec4f;
uniform uHaze: vec3f;
uniform uLantern: vec4f;
uniform uLanternCol: vec3f;
uniform uPond: vec3f;
uniform uMire: vec4f;
varying vWorld: vec3f;
${HASH_WGSL}
${FOG_WGSL}
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let q = input.vWorld.xz;
  let dp = length(q - uniform.uPlayer.xz);
  var ring = sin(dp * 7.0 - uniform.uTime * 5.0) * exp(-dp * 0.6) * uniform.uWet;
  for (var i: i32 = 0; i < 3; i = i + 1) {
    let fi = f32(i);
    let t = uniform.uTime * 0.35 + fi * 0.333;
    let cyc = floor(t);
    let ph = t - cyc;
    let c = uniform.uPond.xy + (vec2f(hash12(vec2f(cyc, fi)), hash12(vec2f(fi, cyc + 7.0))) - vec2f(0.5)) * uniform.uPond.z * 1.2;
    let d = length(q - c);
    ring = ring + sin(d * 10.0 - ph * 12.0) * (1.0 - ph) * step(d, ph * 3.0) * exp(-d * 0.8);
  }
  let mq = q - uniform.uMire.xy;
  let md = length(mq);
  ring = ring + sin(md * 8.0 - uniform.uTime * 9.0) * exp(-md * 0.35) * uniform.uMire.w * 0.7;
  let waves = sin(q.x * 0.9 + uniform.uTime * 0.7) * 0.5 + sin(q.y * 1.3 - uniform.uTime * 0.9) * 0.5;
  let nrm = normalize(vec3f(ring * 0.25 + waves * 0.04, 1.0, ring * 0.25 + waves * 0.03));
  let vd = normalize(input.vWorld - uniform.view_position);
  let r = reflect(vd, nrm);

  let m = max(dot(r, uniform.uMoonSky), 0.0);
  let moon = smoothstep(0.9978, 0.9987, m);
  let halo = pow(m, 60.0) * 0.25;
  let sp = floor(r.xz / max(r.y, 0.05) * 18.0);
  let star = step(0.99, hash12(sp)) * (0.5 + 0.5 * sin(uniform.uTime * 3.0 + hash12(sp + vec2f(3.1)) * 40.0));
  let sky = uniform.uHaze * 0.8 + vec3f(0.95) * (moon * 1.4 + halo) + vec3f(0.5) * star * 0.25;
  var sub = select(0.0, 2.0, moon > 0.5);

  let uv = input.position.xy / uniform.uRtSize;
  let rc = textureSampleLevel(uRefl, uRefl_sampler, vec2f(1.0 - uv.x, uv.y) + nrm.xz * 0.03, 0.0);
  let hasObj = step(0.01, rc.a) * uniform.uReflOn;
  var col = mix(sky, rc.rgb * 0.6, hasObj);
  if (hasObj > 0.5) { sub = 1.0; }

  let fres = mix(0.45, 0.95, pow(1.0 - abs(vd.y), 2.0));
  col = vec3f(0.008, 0.024, 0.02) + col * fres;
  let mbody = 1.0 - smoothstep(uniform.uMire.z * 0.3, uniform.uMire.z * 0.6, md);
  let mang = atan2(mq.y, mq.x);
  let marms = pow(abs(sin(mang * 13.0 + sin(md * 1.3 - uniform.uTime * 0.8) * 1.5)), 40.0) * (1.0 - smoothstep(uniform.uMire.z * 0.35, uniform.uMire.z * 1.3, md));
  let mire = clamp(mbody * 0.9 + marms * 0.8, 0.0, 1.0) * uniform.uMire.w;
  col = mix(col, vec3f(0.035, 0.037, 0.04), mire * 0.92);
  let tl = uniform.uLantern.xyz - input.vWorld;
  let att = clamp(1.0 - length(tl) / uniform.uLantern.w, 0.0, 1.0);
  col = col + uniform.uLanternCol * att * att * 0.3;
  let fog = fogAmount(input.vWorld, uniform.view_position);
  col = mix(col, uniform.uHaze, fog);
  var cls = ${f(CLS.WATER)};
  if (fog > 0.5) { cls = ${f(CLS.GROUND)}; sub = floor(fog * 31.0 + 0.5); }
  output.color = vec4f(col, (cls * 32.0 + sub) / 255.0);
  return output;
}`;

// ---------------------------------------------------------------- full-screen quad vertex
const QUAD_VS_GLSL = `
attribute vec3 vertex_position;
void main(void) {
  gl_Position = vec4(vertex_position.xy, 0.5, 1.0);
}`;
const QUAD_VS_WGSL = `
attribute vertex_position: vec3f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(input.vertex_position.xy, 0.5, 1.0);
  return output;
}`;

// Grade: uMono = 0 -> muted colour (desaturated, teal shadows, warm light kept strongest)
//        uMono = 1 -> monochrome (everything cold grey except warm light)
const GRADE_GLSL = `
uniform float uMono;
vec3 grade(vec3 c) {
  float l = dot(c, vec3(0.3, 0.59, 0.11));
  float mx = max(c.r, max(c.g, c.b));
  float warm = clamp((c.r - c.b) / max(mx, 0.0001) * 1.8 - 0.45, 0.0, 1.0) * smoothstep(0.015, 0.08, l);
  float amber = smoothstep(0.3, 0.42, c.g / max(c.r, 0.0001)); // flame-coloured, not red
  vec3 mono = mix(vec3(l) * vec3(0.94, 0.97, 1.0), c, warm * amber * 0.9);
  // muted colour: keep ~60% saturation, push shadows slightly teal, keep warm light rich
  vec3 muted = mix(vec3(l), c, 0.62) * mix(vec3(0.9, 1.0, 1.04), vec3(1.0), smoothstep(0.05, 0.45, l));
  muted = mix(muted, c, warm * 0.8);
  return mix(muted, mono, uMono);
}`;
const GRADE_WGSL = `
uniform uMono: f32;
fn grade(c: vec3f) -> vec3f {
  let l = dot(c, vec3f(0.3, 0.59, 0.11));
  let mx = max(c.r, max(c.g, c.b));
  let warm = clamp((c.r - c.b) / max(mx, 0.0001) * 1.8 - 0.45, 0.0, 1.0) * smoothstep(0.015, 0.08, l);
  let amber = smoothstep(0.3, 0.42, c.g / max(c.r, 0.0001));
  let mono = mix(vec3f(l) * vec3f(0.94, 0.97, 1.0), c, warm * amber * 0.9);
  var muted = mix(vec3f(l), c, 0.62) * mix(vec3f(0.9, 1.0, 1.04), vec3f(1.0), smoothstep(0.05, 0.45, l));
  muted = mix(muted, c, warm * 0.8);
  return mix(muted, mono, uniform.uMono);
}`;

// ---------------------------------------------------------------- cell pass (one fragment per glyph)
// Output: rgb = glyph colour, a = (glyph index + 128 if the cell is a haze cell) / 255.
// Haze cells get a solid grey background in the composite, so fog reads as fog, not as '@'s.
const CELL_FS_GLSL = `
uniform sampler2D uScene;
uniform float uSS;
uniform float uExposure;
uniform float uEdge;
uniform float uTime;
${HASH_GLSL}
${GRADE_GLSL}
float lumOf(vec3 c) { return 1.0 - exp(-dot(c, vec3(0.3, 0.59, 0.11)) * uExposure); }
vec4 fetchS(ivec2 p, ivec2 mx) { return texelFetch(uScene, clamp(p, ivec2(0), mx), 0); }
void main(void) {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(uScene, 0) - ivec2(1);
  int s = int(uSS + 0.5);
  ivec2 b = cell * s;
  vec4 cc = fetchS(b + ivec2(s / 2), mx);
  vec3 avg = cc.rgb;
  if (s > 1) {
    avg = (fetchS(b, mx).rgb + fetchS(b + ivec2(1, 0), mx).rgb + fetchS(b + ivec2(0, 1), mx).rgb + cc.rgb) * 0.25;
  }
  float L = lumOf(avg);
  float gx = lumOf(fetchS(b + ivec2(s + s / 2, s / 2), mx).rgb) - lumOf(fetchS(b + ivec2(-s + s / 2, s / 2), mx).rgb);
  float gy = lumOf(fetchS(b + ivec2(s / 2, s + s / 2), mx).rgb) - lumOf(fetchS(b + ivec2(s / 2, -s + s / 2), mx).rgb);

  int code = int(cc.a * 255.0 + 0.5);
  int cls = code / 32;
  int sub = code - cls * 32;
  vec2 cuv = (vec2(cell) + 0.5) / vec2((mx + 1) / s);
  vec2 vq = cuv - 0.5;
  float vig = clamp(1.0 - dot(vq, vq) * 1.6, 0.0, 1.0);
  float fogA = (cls == 0) ? 1.0 : ((cls == ${CLS.GRASS} || cls == ${CLS.WATER}) ? 0.0 : float(sub) / 31.0);
  bool haze = fogA > 0.6 || (cls == ${CLS.WATER} && sub == 0);
  int g = 0;
  if (haze) {
    // fog / mirror-water: grey cell with sparse drifting dither glyphs
    float h = hash12(vec2(cell) + vec2(floor(uTime * 5.0), floor(uTime * 3.0) * 7.0));
    int n = ${O.haze[1]};
    if (cls == ${CLS.WATER}) g = ${O.water[0]} + min(4, int(L * 5.0 + h * 1.2));
    else g = ${O.haze[0]} + clamp(int(L * float(n) * 0.55 + (h - 0.5) * 1.6), 0, n - 1);
  } else if (cls == ${CLS.GRASS}) {
    if (L < 0.05) g = 0;
    else if (L < 0.14) g = ${O.grassDim[0]} + 1 + int(step(0.5, hash12(vec2(cell))));
    else g = ${O.grass[0]} + min(sub, 8);
  } else if (cls > 0) {
    int ro = 0; int rn = 1;
    ${rampIfs('glsl')}
    g = ro + min(rn - 1, int(L * float(rn)));
    bool edgy = cls == ${CLS.STONE} || cls == ${CLS.FOLIAGE} || cls == ${CLS.CHAR};
    float ax = abs(gx); float ay = abs(gy);
    if (edgy && L > 0.06 && ax + ay > uEdge) {
      int e = ax > ay * 2.0 ? 0 : (ay > ax * 2.0 ? 1 : (gx * gy > 0.0 ? 3 : 2));
      g = ${O.edge[0]} + e;
    }
  }
  vec3 gc = grade(avg);
  vec3 col;
  if (haze) {
    col = gc * 1.15 * mix(0.55, 1.0, vig);
    g += 128;
  } else {
    vec3 hue = gc / max(max(gc.r, max(gc.g, gc.b)), 0.0001);
    float k = mix(0.3, 1.1, L) * (cls == ${CLS.GLOW} ? 1.3 : 1.0);
    col = hue * k * mix(0.35, 1.0, vig);
  }
  gl_FragColor = vec4(min(col, vec3(1.0)), float(g) / 255.0);
}`;

const CELL_FS_WGSL = `
var uScene: texture_2d<f32>;
var uScene_sampler: sampler;
uniform uSS: f32;
uniform uExposure: f32;
uniform uEdge: f32;
uniform uTime: f32;
${HASH_WGSL}
${GRADE_WGSL}
fn lumOf(c: vec3f) -> f32 { return 1.0 - exp(-dot(c, vec3f(0.3, 0.59, 0.11)) * uniform.uExposure); }
fn fetchS(p: vec2i, mx: vec2i) -> vec4f { return textureLoad(uScene, clamp(p, vec2i(0), mx), 0); }
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let cell = vec2i(input.position.xy);
  let mx = vec2i(textureDimensions(uScene, 0)) - vec2i(1);
  let s = i32(uniform.uSS + 0.5);
  let h2 = s / 2;
  let b = cell * s;
  let cc = fetchS(b + vec2i(h2, h2), mx);
  var avg = cc.rgb;
  if (s > 1) {
    avg = (fetchS(b, mx).rgb + fetchS(b + vec2i(1, 0), mx).rgb + fetchS(b + vec2i(0, 1), mx).rgb + cc.rgb) * 0.25;
  }
  let L = lumOf(avg);
  let gx = lumOf(fetchS(b + vec2i(s + h2, h2), mx).rgb) - lumOf(fetchS(b + vec2i(-s + h2, h2), mx).rgb);
  let gy = lumOf(fetchS(b + vec2i(h2, s + h2), mx).rgb) - lumOf(fetchS(b + vec2i(h2, -s + h2), mx).rgb);

  let code = i32(cc.a * 255.0 + 0.5);
  let cls = code / 32;
  let sub = code - cls * 32;
  let cellf = vec2f(cell);
  let cuv = (cellf + vec2f(0.5)) / vec2f((mx + vec2i(1)) / s);
  let vq = cuv - vec2f(0.5);
  let vig = clamp(1.0 - dot(vq, vq) * 1.6, 0.0, 1.0);
  var fogA = f32(sub) / 31.0;
  if (cls == ${CLS.GRASS} || cls == ${CLS.WATER}) { fogA = 0.0; }
  if (cls == 0) { fogA = 1.0; }
  let haze = fogA > 0.6 || (cls == ${CLS.WATER} && sub == 0);
  var g: i32 = 0;
  if (haze) {
    let h = hash12(cellf + vec2f(floor(uniform.uTime * 5.0), floor(uniform.uTime * 3.0) * 7.0));
    let n = ${O.haze[1]};
    if (cls == ${CLS.WATER}) { g = ${O.water[0]} + min(4, i32(L * 5.0 + h * 1.2)); }
    else { g = ${O.haze[0]} + clamp(i32(L * f32(n) * 0.55 + (h - 0.5) * 1.6), 0, n - 1); }
  } else if (cls == ${CLS.GRASS}) {
    if (L < 0.05) { g = 0; }
    else if (L < 0.14) { g = ${O.grassDim[0]} + 1 + i32(step(0.5, hash12(cellf))); }
    else { g = ${O.grass[0]} + min(sub, 8); }
  } else if (cls > 0) {
    var ro: i32 = 0;
    var rn: i32 = 1;
    ${rampIfs('wgsl')}
    g = ro + min(rn - 1, i32(L * f32(rn)));
    let edgy = cls == ${CLS.STONE} || cls == ${CLS.FOLIAGE} || cls == ${CLS.CHAR};
    let ax = abs(gx);
    let ay = abs(gy);
    if (edgy && L > 0.06 && ax + ay > uniform.uEdge) {
      var e: i32 = 2;
      if (ax > ay * 2.0) { e = 0; }
      else if (ay > ax * 2.0) { e = 1; }
      else if (gx * gy > 0.0) { e = 3; }
      g = ${O.edge[0]} + e;
    }
  }
  let gc = grade(avg);
  var col: vec3f;
  if (haze) {
    col = gc * 1.15 * mix(0.55, 1.0, vig);
    g = g + 128;
  } else {
    let hue = gc / max(max(gc.r, max(gc.g, gc.b)), 0.0001);
    let k = mix(0.3, 1.1, L) * select(1.0, 1.3, cls == ${CLS.GLOW});
    col = hue * k * mix(0.35, 1.0, vig);
  }
  output.color = vec4f(min(col, vec3f(1.0)), f32(g) / 255.0);
  return output;
}`;

// ---------------------------------------------------------------- composite (full resolution)
const COMP_FS_GLSL = `
uniform sampler2D uCells;
uniform sampler2D uAtlas;
uniform vec2 uCell;
uniform float uBgMix;
uniform vec3 uBg;
void main(void) {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 cs = ivec2(uCell + 0.5);
  ivec2 cell = min(px / cs, textureSize(uCells, 0) - ivec2(1));
  ivec2 lp = px - cell * cs;
  vec4 c = texelFetch(uCells, cell, 0);
  int g = int(c.a * 255.0 + 0.5);
  float bg = uBgMix;
  if (g >= 128) { g -= 128; bg = 0.6; }
  float m = texelFetch(uAtlas, ivec2(g * cs.x + lp.x, cs.y - 1 - lp.y), 0).r;
  vec3 col = bg > 0.5 ? c.rgb * (0.26 + m * 0.75) : c.rgb * (m + bg);
  gl_FragColor = vec4(col + uBg, 1.0);
}`;
const COMP_FS_WGSL = `
var uCells: texture_2d<f32>;
var uCells_sampler: sampler;
var uAtlas: texture_2d<f32>;
var uAtlas_sampler: sampler;
uniform uCell: vec2f;
uniform uBgMix: f32;
uniform uBg: vec3f;
uniform uScreenH: f32;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  // WebGPU framebuffer origin is top-left: convert to bottom-left to match the cell texture.
  let px = vec2i(i32(input.position.x), i32(uniform.uScreenH) - 1 - i32(input.position.y));
  let cs = vec2i(uniform.uCell + vec2f(0.5));
  let cell = min(px / cs, vec2i(textureDimensions(uCells, 0)) - vec2i(1));
  let lp = px - cell * cs;
  let c = textureLoad(uCells, cell, 0);
  var g = i32(c.a * 255.0 + 0.5);
  var hazeCell = false;
  if (g >= 128) { g = g - 128; hazeCell = true; }
  let m = textureLoad(uAtlas, vec2i(g * cs.x + lp.x, cs.y - 1 - lp.y), 0).r;
  var col = c.rgb * (m + uniform.uBgMix);
  if (hazeCell) { col = c.rgb * (0.26 + m * 0.75); }
  output.color = vec4f(col + uniform.uBg, 1.0);
  return output;
}`;

// ---------------------------------------------------------------- normal (non-ASCII) display
// Old-film look: tone curve, near-monochrome grade, S-curve contrast, tilt-shift blur at the top
// and bottom (miniature / dollhouse feel), heavy vignette, animated grain and light flicker.
const BLIT_FS_GLSL = `
uniform sampler2D uScene;
uniform vec2 uScreen;
uniform float uTime;
uniform float uBlur;
uniform vec4 uGlow;
${HASH_GLSL}
${GRADE_GLSL}
void main(void) {
  vec2 uv = gl_FragCoord.xy / uScreen;
  vec3 c = texture2D(uScene, uv).rgb;
  float band = smoothstep(0.18, 0.5, abs(uv.y - 0.42));
  if (uBlur > 0.0 && band > 0.01) {
    vec2 o = vec2(uBlur * band) * vec2(uScreen.y / uScreen.x, 1.0); // uBlur = fraction of screen height
    c = (c * 2.0 + texture2D(uScene, uv + vec2(o.x, o.y)).rgb + texture2D(uScene, uv + vec2(-o.x, o.y)).rgb
       + texture2D(uScene, uv + vec2(o.x, -o.y)).rgb + texture2D(uScene, uv + vec2(-o.x, -o.y)).rgb) / 6.0;
  }
  float l0 = dot(c, vec3(0.3, 0.59, 0.11));
  c *= (1.0 - exp(-l0 * 2.4)) / max(l0, 0.0001);
  c = min(grade(c), vec3(1.0));
  vec3 sc = c * c * (3.0 - 2.0 * c);
  c = mix(c, sc, 0.65);
  vec2 gq = (uv - uGlow.xy) * vec2(uScreen.x / uScreen.y, 1.0);
  c += vec3(1.0, 0.52, 0.18) * exp(-dot(gq, gq) / max(uGlow.z * uGlow.z, 0.00001)) * uGlow.w;
  vec2 q = (uv - 0.5) * vec2(uScreen.x / uScreen.y, 1.0);
  float vig = 1.0 - smoothstep(0.25, 1.05, length(q) * (uScreen.x > uScreen.y ? 1.0 : 1.35));
  c *= mix(0.12, 1.0, vig);
  float flick = 1.0 + (hash12(vec2(floor(uTime * 14.0), 3.7)) - 0.5) * 0.035;
  float grain = (hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 811.0) - 0.5) * 0.07;
  c = c * flick + grain;
  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}`;
const BLIT_FS_WGSL = `
var uScene: texture_2d<f32>;
var uScene_sampler: sampler;
uniform uScreen: vec2f;
uniform uTime: f32;
uniform uBlur: f32;
uniform uGlow: vec4f;
${HASH_WGSL}
${GRADE_WGSL}
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  // WebGPU framebuffer origin is top-left; the scene target is bottom-origin
  let fc = vec2f(input.position.x, uniform.uScreen.y - input.position.y);
  let uv = fc / uniform.uScreen;
  var c = textureSampleLevel(uScene, uScene_sampler, uv, 0.0).rgb;
  let band = smoothstep(0.18, 0.5, abs(uv.y - 0.42));
  if (uniform.uBlur > 0.0 && band > 0.01) {
    let o = vec2f(uniform.uBlur * band) * vec2f(uniform.uScreen.y / uniform.uScreen.x, 1.0);
    c = (c * 2.0 + textureSampleLevel(uScene, uScene_sampler, uv + vec2f(o.x, o.y), 0.0).rgb
       + textureSampleLevel(uScene, uScene_sampler, uv + vec2f(-o.x, o.y), 0.0).rgb
       + textureSampleLevel(uScene, uScene_sampler, uv + vec2f(o.x, -o.y), 0.0).rgb
       + textureSampleLevel(uScene, uScene_sampler, uv + vec2f(-o.x, -o.y), 0.0).rgb) / 6.0;
  }
  let l0 = dot(c, vec3f(0.3, 0.59, 0.11));
  c = c * ((1.0 - exp(-l0 * 2.4)) / max(l0, 0.0001));
  c = min(grade(c), vec3f(1.0));
  let sc = c * c * (vec3f(3.0) - 2.0 * c);
  c = mix(c, sc, 0.65);
  let gq = (uv - uniform.uGlow.xy) * vec2f(uniform.uScreen.x / uniform.uScreen.y, 1.0);
  c = c + vec3f(1.0, 0.52, 0.18) * exp(-dot(gq, gq) / max(uniform.uGlow.z * uniform.uGlow.z, 0.00001)) * uniform.uGlow.w;
  let q = (uv - vec2f(0.5)) * vec2f(uniform.uScreen.x / uniform.uScreen.y, 1.0);
  let vig = 1.0 - smoothstep(0.25, 1.05, length(q) * select(1.35, 1.0, uniform.uScreen.x > uniform.uScreen.y));
  c = c * mix(0.12, 1.0, vig);
  let flick = 1.0 + (hash12(vec2f(floor(uniform.uTime * 14.0), 3.7)) - 0.5) * 0.035;
  let grain = (hash12(fc + vec2f(fract(uniform.uTime * 7.31) * 811.0)) - 0.5) * 0.07;
  c = c * flick + vec3f(grain);
  output.color = vec4f(max(c, vec3f(0.0)), 1.0);
  return output;
}`;

// ---------------------------------------------------------------- material factories
const WORLD_ATTRS = {
  vertex_position: pc.SEMANTIC_POSITION,
  vertex_normal: pc.SEMANTIC_NORMAL,
  vertex_color: pc.SEMANTIC_COLOR,
};
const INST_ATTRS = { ...WORLD_ATTRS, inst0: pc.SEMANTIC_ATTR12, inst1: pc.SEMANTIC_ATTR13 };

/** Per-instance layout: inst0 = (x, y, z, scale), inst1 = (rotY, tint, seed, unused). 32 bytes. */
export function instanceFormat(device) {
  return new pc.VertexFormat(device, [
    { semantic: pc.SEMANTIC_ATTR12, components: 4, type: pc.TYPE_FLOAT32 },
    { semantic: pc.SEMANTIC_ATTR13, components: 4, type: pc.TYPE_FLOAT32 },
  ]);
}

export function worldMaterial({ inst = false, push = false, fly = false, sway = 0, emissive = 0, doubleSided = false } = {}) {
  const flags = { inst, push, fly };
  const mat = new pc.ShaderMaterial({
    uniqueName: `world_${+inst}${+push}${+fly}`,
    vertexGLSL: worldVS_GLSL(flags),
    fragmentGLSL: WORLD_FS_GLSL,
    vertexWGSL: worldVS_WGSL(flags),
    fragmentWGSL: WORLD_FS_WGSL,
    attributes: inst ? INST_ATTRS : WORLD_ATTRS,
  });
  mat.setParameter('uSway', sway);
  mat.setParameter('uEmissive', emissive);
  mat.cull = doubleSided ? pc.CULLFACE_NONE : pc.CULLFACE_BACK;
  mat.update();
  return mat;
}

export function waterMaterial() {
  const mat = new pc.ShaderMaterial({
    uniqueName: 'water',
    vertexGLSL: WATER_VS_GLSL,
    fragmentGLSL: WATER_FS_GLSL,
    vertexWGSL: WATER_VS_WGSL,
    fragmentWGSL: WATER_FS_WGSL,
    attributes: { vertex_position: pc.SEMANTIC_POSITION },
  });
  mat.cull = pc.CULLFACE_NONE;
  mat.update();
  return mat;
}

function quadMaterial(name, fsGLSL, fsWGSL) {
  const mat = new pc.ShaderMaterial({
    uniqueName: name,
    vertexGLSL: QUAD_VS_GLSL,
    fragmentGLSL: fsGLSL,
    vertexWGSL: QUAD_VS_WGSL,
    fragmentWGSL: fsWGSL,
    attributes: { vertex_position: pc.SEMANTIC_POSITION },
  });
  mat.cull = pc.CULLFACE_NONE;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.update();
  return mat;
}

export const cellMaterial = () => quadMaterial('asciiCell', CELL_FS_GLSL, CELL_FS_WGSL);
export const compositeMaterial = () => quadMaterial('asciiComposite', COMP_FS_GLSL, COMP_FS_WGSL);
export const blitMaterial = () => quadMaterial('normalBlit', BLIT_FS_GLSL, BLIT_FS_WGSL);
