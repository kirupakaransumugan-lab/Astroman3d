// Lantern Walk scene engine.
// Ported from the original single-file index.html: the three.js code is unchanged
// except that DOM access was replaced by an API object + an onHud callback.
import * as THREE_CORE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const THREE = { ...THREE_CORE, OrbitControls, EffectComposer, RenderPass, ShaderPass, UnrealBloomPass };

/**
 * Builds the scene inside `stage` and starts the render loop.
 * @param {HTMLElement} stage container the canvas is appended to
 * The build is procedural and heavy, so it runs in steps that yield to the browser between them: the page stays
 * responsive and onProgress can drive a loading bar. Shaders are compiled before the first frame is shown.
 * @param {{ onHud?: (hud: object) => void, onProgress?: (fraction: number, label: string) => void, isCancelled?: () => boolean }} opts
 * @returns Promise of a controller with setters, moonView/toggleSit, and dispose()
 */
export function createScene(stage, { onHud = () => {}, onProgress = () => {}, isCancelled = () => false } = {}) {
  const isSmall = Math.min(innerWidth, innerHeight) < 700 || /Mobi|Android/i.test(navigator.userAgent);
  const Q = isSmall ? 0.38 : 1;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lin = h => new THREE.Color(h).convertSRGBToLinear();
  const sstep = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // ---------- deterministic random + value noise ----------
  let _s = 1337;
  const rng = () => { _s |= 0; _s = _s + 0x6D2B79F5 | 0; let t = Math.imul(_s ^ _s >>> 15, 1 | _s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const rand = (a, b) => a + rng() * (b - a);
  function hash3(x, y, z) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177); h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
  function vnoise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const L = (a, b, t) => a + (b - a) * t;
    return L(L(L(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), L(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
             L(L(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), L(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v), w);
  }
  function fbm3(x, y, z, o = 4) { let a = 0.5, s = 0; for (let i = 0; i < o; i++) { s += a * vnoise3(x, y, z); x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; } return s; }

  // ---------- world shape ----------
  const edgeZ = x => 33 + Math.sin(x * 0.11) * 2.2 + Math.sin(x * 0.31) * 0.6;   // meadow ends at z = -edgeZ
  // crash site: the wreck sits at c; the gouge it ploughed runs back along dir
  const CRASH = (() => {
    const c = { x: -9, z: -15 }, dir = { x: 0.5, z: 0.866 }, perp = { x: -0.866, z: 0.5 };
    const wing = { x: c.x + perp.x * 5.6 + dir.x * 1.6, z: c.z + perp.z * 5.6 + dir.z * 1.6 };
    const view = { x: c.x - perp.x * 5.4 - dir.x * 0.5, z: c.z - perp.z * 5.4 - dir.z * 0.5 };
    // it came in low over the forest from the +dir side: one pine snapped off and smouldering, one felled into the meadow
    const at = (al, lt) => ({ x: c.x + dir.x * al + perp.x * lt, z: c.z + dir.z * al + perp.z * lt });
    const snag = at(42, 3.4), stump = at(36, -2.8);
    // the felled pine lies from its stump back toward the wreck, turned a little aside
    const fl = Math.hypot(dir.x + perp.x * 0.25, dir.z + perp.z * 0.25), fall = { dx: -(dir.x + perp.x * 0.25) / fl, dz: -(dir.z + perp.z * 0.25) / fl, len: 13 };
    fall.x = stump.x + fall.dx * 0.45; fall.z = stump.z + fall.dz * 0.45;
    return { c, dir, perp, wing, view, at, snag, stump, fall };
  })();
  function crashField(x, z) { const dx = x - CRASH.c.x, dz = z - CRASH.c.z; return { along: dx * CRASH.dir.x + dz * CRASH.dir.z, lat: dx * CRASH.perp.x + dz * CRASH.perp.z }; }
  function crashBurn(x, z) {
    const f = crashField(x, z);
    const trail = Math.exp(-f.lat * f.lat / 6) * sstep(f.along, -8, -5.5) * (1 - sstep(f.along, 11, 19));
    const blast = 1 - sstep(Math.hypot(x - CRASH.c.x, z - CRASH.c.z), 3.5, 9);
    const wingB = 1 - sstep(Math.hypot(x - CRASH.wing.x, z - CRASH.wing.z), 1.2, 3.6);
    const snagB = 0.75 * (1 - sstep(Math.hypot(x - CRASH.snag.x, z - CRASH.snag.z), 0.6, 2.4));
    return Math.min(1, Math.max(trail, blast, wingB, snagB));
  }
  function crashBlocked(x, z, pad = 0) {
    const f = crashField(x, z);
    if (f.along > -7.2 - pad && f.along < 5.4 + pad && Math.abs(f.lat) < 3.3 + pad) return true;
    return Math.hypot(x - CRASH.wing.x, z - CRASH.wing.z) < 2.6 + pad;
  }
  function heightAt(x, z) {
    let h = Math.sin(x * 0.075) * 0.55 + Math.cos(z * 0.068 + 1.3) * 0.45 + Math.sin((x + z) * 0.14) * 0.22 + Math.sin(x * 0.31 + z * 0.23) * 0.08;
    h += sstep(-z, 18, 31) * 1.1;
    { const f = crashField(x, z);
      if (f.along > -9 && f.along < 19 && Math.abs(f.lat) < 5) {
        const l2 = f.lat * f.lat;
        const trench = 0.5 * Math.exp(-l2 / 2.6) * sstep(f.along, -6.5, -4) * (1 - sstep(f.along, 9, 17));
        const berm = 0.75 * Math.exp(-l2 / 4.0) * Math.exp(-Math.pow((f.along + 5.9) / 1.1, 2));
        const lips = 0.2 * Math.exp(-Math.pow(Math.abs(f.lat) - 1.9, 2) / 0.25) * sstep(f.along, -6, -3) * (1 - sstep(f.along, 8, 16));
        h += berm + lips - trench;
      } }
    const t = -z - edgeZ(x);
    if (t > 0) h -= Math.min(90, Math.pow(t, 1.55) * 1.4);
    return h;
  }
  function inMeadow(x, z, pad = 0) {
    const r = Math.hypot(x, z);
    if (r < 19 - pad) return true;
    if (z < 0) { const halfW = 11 + (-z) * 0.22 - pad; return Math.abs(x) < halfW && -z < edgeZ(x) - 1.6 - pad; }
    return false;
  }
  function meadowDensity(x, z) {
    if (onSlab(x, z, 1.3)) return 0;
    const burnK = 1 - sstep(crashBurn(x, z), 0.5, 0.82);
    if (burnK <= 0) return 0;
    const F = CRASH.fall, ft = Math.max(0, Math.min(F.len * 0.4, (x - F.x) * F.dx + (z - F.z) * F.dz));
    const trunkK = sstep(Math.hypot(x - F.x - F.dx * ft, z - F.z - F.dz * ft), 0.3, 0.85);
    return meadowDensity0(x, z) * burnK * trunkK;
  }
  function meadowDensity0(x, z) {
    const r = Math.hypot(x, z);
    let d = 1 - sstep(r, 20, 27);
    if (z < 0) {
      const halfW = 12 + (-z) * 0.24;
      const c = (1 - sstep(Math.abs(x), halfW - 3, halfW + 3)) * (1 - sstep(-z, edgeZ(x) - 1.2, edgeZ(x) - 0.1));
      d = Math.max(d, c);
    }
    return d;
  }
  const MOON_DIR = new THREE.Vector3(-0.02, 0.2, -1).normalize();
  // a flat rock ledge that overhangs the cliff, facing the moon
  const LEDGE = (() => {
    const x = 1.6, e = edgeZ(1.6);
    const face = Math.atan2(MOON_DIR.x, MOON_DIR.z), fx = Math.sin(face), fz = Math.cos(face);
    const z = -(e + 0.1), baseY = heightAt(x, -(e - 0.45));
    const y = baseY - 0.12, sy = 0.62;
    return { x, z, rx: 1.4, rz: 0.92, y, sy, top: y + 0.28 * sy, face, fx, fz, seat: new THREE.Vector3(x + fx * 0.5, 0, z + fz * 0.5) };
  })();
  function onSlab(x, z, k = 1) { const a = (x - LEDGE.x) / (LEDGE.rx * k), b = (z - LEDGE.z) / (LEDGE.rz * k); return a * a + b * b < 1; }
  function surfaceY(x, z) { return onSlab(x, z, 0.92) ? Math.max(LEDGE.top, heightAt(x, z)) : heightAt(x, z); }
  // static obstacles the walkers plan around (rocks, fires, wreckage, wheel)
  const OBST = [];
  function obstacleHit(x, z, clear) { for (const o of OBST) { const dx = x - o.x, dz = z - o.z, r = o.r + clear; if (dx * dx + dz * dz < r * r) return o; } return null; }
  function walkable(x, z, clear = 0.32) { return canWalk(x, z) && !obstacleHit(x, z, clear); }
  function canWalk(x, z) {
    if (crashBlocked(x, z)) return false;
    if (inMeadow(x, z, 0.6)) return true;
    const a = (x - LEDGE.x) / 1.8, b = (z - (LEDGE.z + 0.8)) / 2.1;
    return a * a + b * b < 1 && (onSlab(x, z, 0.82) || -z < edgeZ(x) - 0.35);
  }

  // ---------- GLSL noise ----------
  const GLSL_NOISE = `
  float h13(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  vec3 h33(vec3 p){ p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453123); }
  float vn(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(h13(i),h13(i+vec3(1,0,0)),f.x), mix(h13(i+vec3(0,1,0)),h13(i+vec3(1,1,0)),f.x), f.y),
               mix(mix(h13(i+vec3(0,0,1)),h13(i+vec3(1,0,1)),f.x), mix(h13(i+vec3(0,1,1)),h13(i+vec3(1,1,1)),f.x), f.y), f.z); }
  float fbm(vec3 p){ float s = 0.0, a = 0.5; for(int i=0;i<5;i++){ s += a*vn(p); p = p*2.02 + vec3(1.7,9.2,3.1); a *= 0.5; } return s; }
  `;
  const GLSL_CLOUD = `
  float cloudDensity(vec3 d, float t){
    if (d.y <= 0.0) return 0.0;
    vec2 uv = d.xz / (d.y + 0.18);
    vec3 p = vec3(uv * 0.7 + vec2(t * 0.007, t * 0.0025), t * 0.0025);
    float n = fbm(p) + 0.45 * fbm(p * 3.3 + 5.0) + 0.12 * vn(p * 14.0);
    float c = smoothstep(0.86, 1.14, n);
    return c * smoothstep(0.0, 0.09, d.y) * (1.0 - smoothstep(0.6, 0.98, d.y));
  }
  `;

  async function start() {
  const listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push([target, type, fn]); };
  let rafId = 0, disposed = false, hudAt = -1, hudFlags = '';
  // ---------- renderer ----------
  const canPost = !!(THREE.EffectComposer && THREE.RenderPass && THREE.ShaderPass && THREE.UnrealBloomPass);
  // With post-processing the scene is drawn into the composer's multisampled target and only a full-screen quad reaches
  // the canvas, so a multisampled canvas would cost memory and a resolve every frame without smoothing anything.
  const renderer = new THREE.WebGLRenderer({ antialias: !canPost, powerPreference: 'high-performance' });
  // Render at the screen's full pixel density for a sharp image (capped at 2; beyond that the extra cost isn't visible).
  // adaptResolution() may step this down on a device that can't hold the frame rate, and back up when it can.
  const PR_MAX = Math.min(devicePixelRatio, isSmall ? 1.5 : 2), PR_MIN = Math.min(PR_MAX, 1);
  let PR = PR_MAX;
  const prU = { value: PR }; // shared by point-sprite shaders
  renderer.setPixelRatio(PR);
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  stage.appendChild(renderer.domElement);
  // yield to the browser between build steps so the page stays responsive and the loading bar can paint
  const buildLog = []; let buildT = performance.now(), buildLabel = 'Renderer';
  async function step(label, fraction) {
    const now = performance.now(); buildLog.push([buildLabel, Math.round(now - buildT)]); buildLabel = label;
    onProgress(fraction, label);
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    buildT = performance.now();
    if (isCancelled()) { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); throw Object.assign(new Error('cancelled'), { cancelled: true }); }
  }
  await step('Preparing the night', 0.03);
  if (!canPost) { renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.32; }

  const scene = new THREE.Scene();
  const HORIZON = lin(0x1a2740), ZENITH = lin(0x03060f);
  scene.fog = new THREE.FogExp2(HORIZON.clone().multiplyScalar(0.8), 0.017);

  const camera = new THREE.PerspectiveCamera(48, stage.clientWidth / stage.clientHeight, 0.05, 1600);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 1.6; controls.maxDistance = 34;
  controls.maxPolarAngle = Math.PI * 0.53;

  // ---------- procedural textures ----------
  function normalMapFrom(size, heightFn, strength) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'); const img = g.createImageData(size, size);
    const H = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = heightFn(x, y);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const l = H[y * size + ((x - 1 + size) % size)], r = H[y * size + ((x + 1) % size)];
      const u = H[((y - 1 + size) % size) * size + x], d = H[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  const S = 128;
  const fabricN = normalMapFrom(S, (x, y) => {
    const wx = Math.sin(x / S * Math.PI * 2 * 24), wy = Math.sin(y / S * Math.PI * 2 * 24);
    const weave = (wx > 0 ? wy : -wy) * 0.35;
    return weave + fbm3(x / S * 8, y / S * 8, 3, 3) * 1.6 + fbm3(x / S * 2, y / S * 2, 9, 2) * 1.2;
  }, 2.2);
  fabricN.repeat.set(5, 5);
  const furN = normalMapFrom(S, (x, y) => fbm3(x / S * 40, y / S * 4, 1, 3) * 2 + vnoise3(x / S * 90, y / S * 9, 5) * 0.8, 2.8);
  furN.repeat.set(3, 3);
  function glowTexture(r, g, b) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'); const grd = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, `rgba(${r},${g},${b},1)`); grd.addColorStop(0.2, `rgba(${r},${g},${b},0.45)`);
    grd.addColorStop(0.55, `rgba(${r},${g},${b},0.1)`); grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grd; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
  }
  function labelTexture(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t;
  }

  await step('Painting the sky', 0.06);
  // ======================================================================
  // SKY: gradient + Milky Way + procedural stars, star points, moon, mountains
  // ======================================================================
  const skyGroup = new THREE.Group(); scene.add(skyGroup);
  const skyUniforms = {
    uMoonDir: { value: MOON_DIR }, uTime: { value: 0 }, uMW: { value: new THREE.Vector3() },
    uHorizon: { value: HORIZON }, uZenith: { value: ZENITH }, uSkyGain: { value: 1 }, uCloud: { value: 0.55 },
    uGC: { value: new THREE.Vector3(-0.62, 0.3, -0.72).normalize() }
  };
  skyUniforms.uMW.value.crossVectors(skyUniforms.uGC.value, new THREE.Vector3(0.35, 1, 0.3)).normalize();
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uMoonDir, uMW, uGC, uHorizon, uZenith; uniform float uTime, uSkyGain, uCloud; varying vec3 vDir;
      ${GLSL_NOISE}
      ${GLSL_CLOUD}
      vec3 starLayer(vec3 d, float scale, float density, float rad, float h){
        vec3 p = d*scale; vec3 c = floor(p); vec3 f = fract(p);
        vec3 r = h33(c);
        float present = step(1.0 - density, h13(c + 11.3));
        float dist = length(f - (0.25 + 0.5*r));
        float mag = pow(h13(c + 3.7), 9.0);
        float sc = 0.22 + 0.45*(1.0 - smoothstep(0.0, 0.35, h));
        float tw = 1.0 - sc + sc*sin(uTime*(1.1 + r.x*4.0) + r.y*50.0);
        float t = h13(c + 5.1);
        vec3 tint = t < 0.2 ? vec3(0.7,0.82,1.25) : (t < 0.8 ? vec3(1.0,0.98,0.95) : (t < 0.94 ? vec3(1.2,0.95,0.7) : vec3(1.3,0.72,0.5)));
        return tint * present * smoothstep(rad, 0.0, dist) * (0.05 + 3.2*mag) * tw;
      }
      vec3 meteor(vec3 d){
        float P = 6.0; float k = floor(uTime / P); float lt = uTime - k*P; float dur = 0.85;
        if (lt > dur) return vec3(0.0);
        vec3 r = h33(vec3(k, 3.1, 7.7));
        float az = 3.1416 + (r.x - 0.5)*2.6, el = 0.25 + r.y*0.55;
        vec3 p0 = normalize(vec3(sin(az)*cos(el), sin(el), cos(az)*cos(el)));
        vec3 tA = normalize(cross(p0, vec3(0.0,1.0,0.0))); vec3 tB = cross(tA, p0);
        float ang = -0.6 - r.z*1.6;
        vec3 v = normalize(tA*cos(ang) + tB*sin(ang)); vec3 w = cross(p0, v);
        float dp = dot(d, p0); if (dp < 0.85) return vec3(0.0);
        vec3 q = d/dp - p0;
        float a = dot(q, v), bb = dot(q, w);
        float prog = lt/dur, head = prog*0.32, len = 0.11;
        float tail = clamp((a - (head - len))/len, 0.0, 1.0) * step(a, head);
        float fade = sin(prog*3.1416);
        float wdt = 0.0008 + 0.0012*tail;
        return vec3(0.85,0.95,1.0) * tail*tail * fade * smoothstep(wdt, 0.0, abs(bb)) * 5.0;
      }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y, hh = max(h, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(hh, 0.38));
        float md = max(dot(d, uMoonDir), 0.0);
        col += vec3(0.010,0.020,0.046) * pow(md, 2.5) * (1.0 - 0.5*hh);
        col += vec3(0.06,0.075,0.11) * pow(md, 40.0);
        col += vec3(0.28,0.31,0.40) * pow(md, 1200.0);
        col += vec3(0.003,0.010,0.005) * exp(-pow((h - 0.1)/0.07, 2.0));
        col = mix(col, uHorizon*1.12, exp(-hh*22.0)*0.6);
        col = mix(col, uHorizon*0.5, smoothstep(0.0, -0.12, h));
        // Milky Way: bright warm core, bluish arms, ridged dust lanes and grainy star clouds
        float b = dot(d, uMW);
        float gcAng = acos(clamp(dot(d, uGC), -1.0, 1.0));
        float bulge = exp(-gcAng*gcAng*2.4);
        float band = exp(-b*b*(13.0 - 6.0*bulge));
        float core = exp(-b*b*70.0);
        float c1 = fbm(d*2.4 + 1.3), c2 = fbm(d*7.0 + 4.1);
        float grain = vn(d*70.0)*0.6 + vn(d*150.0)*0.4;
        float ridge = pow(1.0 - abs(2.0*fbm(d*4.5 + 9.0) - 1.0), 5.0);
        float rift = smoothstep(0.035, 0.0, abs(b + 0.015 + 0.025*sin(gcAng*4.0))) * (0.5 + 0.5*c2);
        float dust = ridge*band*0.9 + rift*(0.5 + bulge);
        float mw = band*(0.22 + c1*1.1)*(0.55 + 0.9*c2) + core*(0.45 + bulge*2.2)*(0.5 + c2);
        mw *= (0.7 + 0.6*grain);
        mw *= clamp(1.0 - dust*0.85, 0.06, 1.0);
        vec3 mwCol = mix(vec3(0.74,0.82,1.0), vec3(1.0,0.84,0.64), clamp(bulge*0.9 + core*0.2, 0.0, 1.0));
        float ext = smoothstep(-0.02, 0.25, h);
        float glare = 1.0 - 0.8*pow(md, 8.0);
        col += mwCol * 0.05 * mw * ext * glare;
        vec3 st = starLayer(d, 200.0, 0.38, 0.24, h) + 0.75*starLayer(d, 480.0, 0.55, 0.27, h)
                + 1.6*band*starLayer(d, 950.0, 0.85, 0.3, h) + 1.1*(band*bulge + core)*starLayer(d, 1600.0, 0.9, 0.32, h);
        col += st * ext * glare;
        col += meteor(d) * ext;
        // moonlit clouds drifting across, silver-lined near the moon
        float c = cloudDensity(d, uTime) * uCloud;
        vec3 cloudCol = vec3(0.012,0.017,0.03) + vec3(0.035,0.04,0.058)*pow(md, 2.0) + vec3(0.55,0.57,0.62)*pow(md, 22.0);
        col = mix(col, cloudCol, clamp(c * 1.1, 0.0, 0.96));
        gl_FragColor = vec4(col * uSkyGain, 1.0);
      }`
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), skyMat);
  skyDome.renderOrder = -10; skyDome.frustumCulled = false;
  skyGroup.add(skyDome);

  // bright star points with colour temperature and twinkle
  const starPoints = (() => {
    const n = Math.round(3200 * (isSmall ? 0.6 : 1)), pos = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = rng(), v = rand(-0.05, 1); const th = u * Math.PI * 2, phi = Math.acos(v);
      pos[i * 3] = 860 * Math.sin(phi) * Math.cos(th); pos[i * 3 + 1] = 860 * Math.cos(phi); pos[i * 3 + 2] = 860 * Math.sin(phi) * Math.sin(th);
      const m = Math.pow(rng(), 3.2);
      sz[i] = 2.2 + m * 6.5; ph[i] = rng() * 100;
      const t = rng(); const c = t < 0.25 ? [0.75, 0.85, 1.2] : t < 0.8 ? [1, 0.97, 0.93] : [1.2, 0.9, 0.65];
      const b = 0.35 + m * 2.8; col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1)); g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: skyUniforms.uTime, uPR: prU, uMoonDir: skyUniforms.uMoonDir, uGain: skyUniforms.uSkyGain, uCloud: skyUniforms.uCloud },
      vertexShader: `attribute float size; attribute float phase; attribute vec3 color; uniform float uTime, uPR, uCloud; uniform vec3 uMoonDir; varying vec3 vC;
        ${GLSL_NOISE}
        ${GLSL_CLOUD}
        void main(){ vec3 d = normalize(position); float ext = smoothstep(-0.02, 0.2, d.y) * (1.0 - clamp(cloudDensity(d, uTime) * uCloud * 1.2, 0.0, 1.0));
          float glare = 1.0 - 0.85*pow(max(dot(d,uMoonDir),0.0), 14.0);
          float sc = 0.25 + 0.45*(1.0 - smoothstep(0.0, 0.35, d.y)); float tw = 1.0 - sc + sc*sin(uTime*(1.2 + fract(phase)*3.0) + phase);
          vC = color * ext * glare * tw;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uPR; }`,
      fragmentShader: `uniform float uGain; varying vec3 vC; void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p);
          float a = exp(-r*r*42.0) + 0.12*exp(-r*r*7.0); gl_FragColor = vec4(vC * a * uGain, 1.0); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    });
    const pts = new THREE.Points(g, m); pts.renderOrder = -9; pts.frustumCulled = false; return pts;
  })();
  skyGroup.add(starPoints);

  // the moon: procedural maria, craters at three scales, ray craters, limb darkening
  const moonMat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: MOON_DIR.clone().negate().add(new THREE.Vector3(0.16, 0.08, 0)).normalize() }, uBright: { value: 2.3 }, uTime: skyUniforms.uTime, uCloud: skyUniforms.uCloud },
    fog: false, depthWrite: false,
    vertexShader: `varying vec3 vN; varying vec3 vNW; varying vec3 vWP;
      void main(){ vN = normal; vNW = normalize(mat3(modelMatrix)*normal); vWP = (modelMatrix*vec4(position,1.0)).xyz; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uSunDir; uniform float uBright, uTime, uCloud; varying vec3 vN; varying vec3 vNW; varying vec3 vWP;
      ${GLSL_NOISE}
      ${GLSL_CLOUD}
      vec2 craters(vec3 p, float prob){
        vec3 c = floor(p), f = fract(p); float bowl = 0.0, rim = 0.0;
        for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
          vec3 g = vec3(float(x),float(y),float(z)); vec3 id = c + g;
          float has = step(1.0 - prob, h13(id + 2.1));
          float r = 0.16 + 0.3*h13(id + 8.4);
          float d = length(g + h33(id) - f) / r;
          bowl = max(bowl, has*(1.0 - smoothstep(0.75, 1.0, d))*(0.55 + 0.45*(1.0 - d*d)));
          rim = max(rim, has*exp(-pow((d - 1.0)*6.5, 2.0)));
        }
        return vec2(bowl, rim);
      }
      float rayCrater(vec3 n, vec3 dir, float reach, float seed){
        float ang = acos(clamp(dot(n, dir), -1.0, 1.0));
        vec3 a = normalize(cross(dir, vec3(0.0,1.0,0.0))); vec3 b = cross(dir, a);
        float az = atan(dot(n,b), dot(n,a));
        float streak = smoothstep(0.55, 0.92, vn(vec3(az*6.0, seed, 1.0)))*0.8 + smoothstep(0.6, 0.95, vn(vec3(az*15.0, seed+3.0, 2.0)))*0.5;
        return streak*exp(-ang*reach)*smoothstep(0.02, 0.05, ang) + exp(-pow(ang/0.025, 2.0))*1.3;
      }
      void main(){
        vec3 n = normalize(vN);
        float alb = 0.63 + 0.12*(fbm(n*9.0) - 0.5) + 0.06*(fbm(n*28.0) - 0.5);
        float maria = smoothstep(0.5, 0.6, fbm(n*1.6 + vec3(2.3,0.7,5.1)));
        maria = max(maria, 0.85*smoothstep(0.55, 0.63, fbm(n*2.5 + vec3(7.0, 1.0, 3.0))));
        maria *= smoothstep(-0.6, 0.2, n.y + 0.3*n.x);
        alb = mix(alb, 0.30 + 0.08*fbm(n*12.0), maria);
        vec2 c1 = craters(n*4.5, 0.42), c2 = craters(n*12.0, 0.5), c3 = craters(n*30.0, 0.55);
        alb += -0.07*c1.x + 0.13*c1.y;
        alb += (-0.05*c2.x + 0.1*c2.y)*(1.0 - 0.55*maria);
        alb += (-0.03*c3.x + 0.06*c3.y)*(1.0 - 0.65*maria);
        alb += 0.16*rayCrater(n, normalize(vec3(-0.12,-0.58,0.8)), 3.2, 1.0);
        alb += 0.09*rayCrater(n, normalize(vec3(-0.35,0.18,0.92)), 6.0, 7.0);
        alb += 0.07*rayCrater(n, normalize(vec3(-0.62,0.05,0.78)), 7.0, 13.0);
        vec3 nw = normalize(vNW);
        float lam = max(dot(nw, uSunDir), 0.0);
        float lit = pow(lam, 0.42) * smoothstep(0.0, 0.08, lam);
        vec3 col = vec3(alb) * vec3(1.0, 0.975, 0.92) * lit * uBright;
        float cl = clamp(cloudDensity(normalize(vWP - cameraPosition), uTime) * uCloud * 1.1, 0.0, 0.92);
        col = mix(col, vec3(0.62, 0.64, 0.7) * (0.5 + 0.5*alb), cl);
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(20, 96, 64), moonMat);
  moon.position.copy(MOON_DIR).multiplyScalar(780);
  moon.rotation.y = 0.15;
  moon.renderOrder = -8; moon.frustumCulled = false;
  skyGroup.add(moon);

  // distant mountain ranges, hazed by moonlight
  function makeRange(R, base, amp, freq, seed, topCol, botCol) {
    const segs = 420, pos = [], col = [], idx = [];
    const ct = lin(topCol), cb = lin(botCol);
    for (let i = 0; i <= segs; i++) {
      const a = i / segs * Math.PI * 2;
      const ridge = fbm3(Math.cos(a) * freq, Math.sin(a) * freq, seed, 5);
      const sharp = Math.pow(Math.abs(ridge - 0.5) * 2, 0.8);
      const top = base + amp * (0.25 + ridge * 0.9 + sharp * 0.35);
      pos.push(Math.cos(a) * R, -60, Math.sin(a) * R, Math.cos(a) * R, top, Math.sin(a) * R);
      col.push(cb.r, cb.g, cb.b, ct.r, ct.g, ct.b);
      if (i < segs) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, depthWrite: false, side: THREE.DoubleSide }));
    m.frustumCulled = false; return m;
  }
  const farRange = makeRange(720, -8, 75, 3.2, 4, 0x0e1626, 0x1b2a42); farRange.renderOrder = -7;
  const nearRange = makeRange(560, -22, 52, 5.5, 9, 0x070b13, 0x131d2f); nearRange.renderOrder = -6;
  skyGroup.add(farRange, nearRange);
  const mist = new THREE.Mesh(new THREE.CylinderGeometry(470, 470, 70, 160, 1, true), new THREE.ShaderMaterial({
    uniforms: { uTime: skyUniforms.uTime, uGain: skyUniforms.uSkyGain, uCol: { value: lin(0x31435f) }, uMoonDir: skyUniforms.uMoonDir },
    transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime, uGain; uniform vec3 uCol, uMoonDir; varying vec3 vP; ${GLSL_NOISE}
      void main(){ float y = (vP.y + 35.0)/70.0; float a = smoothstep(0.95, 0.3, y) * smoothstep(0.0, 0.25, y);
        float ang = atan(vP.z, vP.x); float n = fbm(vec3(ang*5.0 + uTime*0.006, y*2.5, uTime*0.015));
        float toward = pow(max(dot(normalize(vec3(vP.x, 0.0, vP.z)), normalize(vec3(uMoonDir.x, 0.0, uMoonDir.z))), 0.0), 6.0);
        a *= 0.3 + 0.7*n;
        gl_FragColor = vec4(uCol * (1.0 + toward*1.2) * uGain, a*0.32); }`
  }));
  mist.position.y = -32; mist.renderOrder = -5; mist.frustumCulled = false;
  skyGroup.add(mist);

  // ---------- environment map (for the visor, helmet, metal and glass) ----------
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(skyDome.geometry, skyMat));
  { const m2 = new THREE.Mesh(moon.geometry, moonMat); m2.position.copy(moon.position); envScene.add(m2); }
  envScene.add(new THREE.Mesh(farRange.geometry, farRange.material), new THREE.Mesh(nearRange.geometry, nearRange.material));
  { const gnd = new THREE.Mesh(new THREE.CircleGeometry(800, 32), new THREE.MeshBasicMaterial({ color: lin(0x060a07) })); gnd.rotation.x = -Math.PI / 2; gnd.position.y = -3; envScene.add(gnd); }
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCam = new THREE.CubeCamera(1, 2000, cubeRT);
  cubeCam.update(renderer, envScene);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromCubemap(cubeRT.texture).texture;

  // ======================================================================
  // LIGHTS
  // ======================================================================
  const hemi = new THREE.HemisphereLight(lin(0x4a5d92), lin(0x14200f), 0.9);
  scene.add(hemi);
  // soft sky fill from the side opposite the moon, so figures seen against the moon still read
  const fill = new THREE.DirectionalLight(lin(0x7f93c8), 0.35);
  fill.position.set(-MOON_DIR.x * 50 + 20, 25, -MOON_DIR.z * 50);
  scene.add(fill);
  const moonLight = new THREE.DirectionalLight(lin(0xaabdf0), 0.75);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(isSmall ? 1024 : 2048, isSmall ? 1024 : 2048);
  Object.assign(moonLight.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 160 });
  moonLight.shadow.bias = -0.0006; moonLight.shadow.normalBias = 0.02;
  scene.add(moonLight, moonLight.target);

  await step('Shaping the meadow', 0.16);
  // ======================================================================
  // TERRAIN
  // ======================================================================
  {
    const g = new THREE.PlaneGeometry(320, 320, isSmall ? 140 : 220, isSmall ? 140 : 220);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    const soil = lin(0x2a2216), moss = lin(0x1b2a12), dry = lin(0x3a3420), rock = lin(0x3a3a38), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = heightAt(x, z); p.setY(i, y);
      const n = fbm3(x * 0.18, z * 0.18, 2, 4), n2 = fbm3(x * 0.9, z * 0.9, 7, 3);
      c.copy(soil).lerp(moss, sstep(n, 0.35, 0.6)).lerp(dry, sstep(n2, 0.55, 0.75) * 0.5);
      if (-z > edgeZ(x) - 0.5) c.lerp(rock, 0.6 * sstep(-z - edgeZ(x), -0.5, 3));
      const bn = crashBurn(x, z);
      if (bn > 0) { c.lerp(lin(0x0d0b09), bn * 0.88); if (vnoise3(x * 2.2, z * 2.2, 11) > 0.68) c.lerp(lin(0x3c3835), 0.45 * bn); }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    // tiling soil detail: grit, pebbles, dead grass litter
    const groundTex = (() => {
      const S2 = 512, c = document.createElement('canvas'); c.width = c.height = S2; const g2 = c.getContext('2d');
      g2.fillStyle = '#d9d4cc'; g2.fillRect(0, 0, S2, S2);
      const wrapDraw = (fn) => { for (const ox of [-S2, 0, S2]) for (const oy of [-S2, 0, S2]) { g2.save(); g2.translate(ox, oy); fn(); g2.restore(); } };
      for (let k = 0; k < 260; k++) { const x = rng() * S2, y = rng() * S2, r = rand(20, 90), a = rand(0.05, 0.18);
        wrapDraw(() => { const gr = g2.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(70,55,35,${a})`); gr.addColorStop(1, 'rgba(70,55,35,0)'); g2.fillStyle = gr; g2.fillRect(x - r, y - r, r * 2, r * 2); }); }
      for (let k = 0; k < 4200; k++) { const x = rng() * S2, y = rng() * S2, r = rand(0.6, 2.6), l = rng() < 0.5; const col = l ? `rgba(245,240,230,${rand(0.3, 0.7)})` : `rgba(40,32,22,${rand(0.3, 0.8)})`;
        wrapDraw(() => { g2.fillStyle = col; g2.beginPath(); g2.arc(x, y, r, 0, 7); g2.fill(); }); }
      for (let k = 0; k < 700; k++) { const x = rng() * S2, y = rng() * S2, a = rng() * 6.28, L = rand(4, 16);
        wrapDraw(() => { g2.strokeStyle = `rgba(${150 + rng() * 60 | 0},${130 + rng() * 40 | 0},80,0.55)`; g2.lineWidth = rand(0.6, 1.6); g2.beginPath(); g2.moveTo(x, y); g2.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); g2.stroke(); }); }
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(110, 110); t.anisotropy = 8; return t;
    })();
    const terrain = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, map: groundTex }));
    terrain.receiveShadow = true;
    scene.add(terrain);
    const valley = new THREE.Mesh(new THREE.PlaneGeometry(1600, 800), new THREE.ShaderMaterial({
      uniforms: { uTime: skyUniforms.uTime, uGain: skyUniforms.uSkyGain, uMoonDir: skyUniforms.uMoonDir, uCol: { value: lin(0x3b4c6b) } },
      transparent: true, depthWrite: false, fog: false,
      vertexShader: `varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: `uniform float uTime, uGain; uniform vec3 uMoonDir, uCol; varying vec3 vW; ${GLSL_NOISE}
        void main(){
          float n = fbm(vec3(vW.xz * 0.012 + vec2(uTime * 0.004, uTime * 0.0015), uTime * 0.002));
          float n2 = fbm(vec3(vW.xz * 0.05 + vec2(uTime * 0.01, 0.0), 3.0));
          float dens = smoothstep(0.3, 0.78, n * 0.75 + n2 * 0.4);
          vec3 toP = normalize(vec3(vW.x - cameraPosition.x, 0.0, vW.z - cameraPosition.z));
          float glint = pow(max(dot(toP, normalize(vec3(uMoonDir.x, 0.0, uMoonDir.z))), 0.0), 10.0);
          vec3 col = uCol * (0.55 + 0.75 * dens) + vec3(0.16, 0.18, 0.24) * glint * (0.4 + dens);
          float a = (0.82 + 0.18 * dens) * smoothstep(-38.0, -60.0, vW.z);
          gl_FragColor = vec4(col * uGain, a);
        }`
    }));
    valley.rotation.x = -Math.PI / 2; valley.position.set(0, LEDGE.top - 24, -400); valley.renderOrder = 1; valley.frustumCulled = false;
    scene.add(valley);
  }

  await step('Growing the grass', 0.22);
  // ======================================================================
  // VEGETATION: shared wind + parting shader
  // ======================================================================
  const veg = { uTime: { value: 0 }, uP0: { value: new THREE.Vector3(0, 0, 999) }, uP1: { value: new THREE.Vector3(0, 0, 999) }, uP2: { value: new THREE.Vector3(0, 0, 999) }, uP3: { value: new THREE.Vector3(0, 0, 999) } };
  function vegMaterial(flex) {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const uFlex = { value: flex };
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = veg.uTime; sh.uniforms.uP0 = veg.uP0; sh.uniforms.uP1 = veg.uP1; sh.uniforms.uP2 = veg.uP2; sh.uniforms.uP3 = veg.uP3; sh.uniforms.uFlex = uFlex;
      sh.vertexShader = 'uniform float uTime; uniform float uFlex; uniform vec3 uP0; uniform vec3 uP1; uniform vec3 uP2; uniform vec3 uP3;\n' + sh.vertexShader.replace('#include <project_vertex>', `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec2 basePos = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        #else
          vec2 basePos = vec2(0.0);
        #endif
        float bend = position.y * position.y;
        vec2 d0 = mvPosition.xz - uP0.xz; float p0 = smoothstep(0.85, 0.1, length(d0));
        vec2 d1 = mvPosition.xz - uP1.xz; float p1 = smoothstep(0.6, 0.05, length(d1));
        mvPosition.xz += normalize(d0 + 1e-4) * p0 * 0.75 * bend + normalize(d1 + 1e-4) * p1 * 0.5 * bend;
        mvPosition.y -= (p0 * 0.4 + p1 * 0.28) * bend;
        vec2 d2 = mvPosition.xz - uP2.xz; float p2 = smoothstep(0.9, 0.12, length(d2));
        vec2 d3 = mvPosition.xz - uP3.xz; float p3 = smoothstep(0.82, 0.12, length(d3));
        mvPosition.xz += normalize(d2 + 1e-4) * p2 * 0.6 * bend + normalize(d3 + 1e-4) * p3 * 0.55 * bend;
        mvPosition.y -= (p2 * 0.3 + p3 * 0.28) * bend;
        float phase = fract(sin(dot(basePos, vec2(12.9898, 78.233))) * 43758.5) * 6.2831;
        float gust = sin(dot(basePos, vec2(0.11, 0.07)) - uTime * 1.15) * 0.5 + 0.5;
        gust = gust * gust * gust;
        float w = sin(uTime * 2.0 + phase) * 0.09 + sin(uTime * 3.7 + phase * 1.7) * 0.04 + gust * 0.32;
        vec2 wind = normalize(vec2(1.0, 0.45));
        mvPosition.xz += wind * w * bend * uFlex;
        mvPosition.y -= abs(w) * bend * 0.12 * uFlex;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
      sh.fragmentShader = sh.fragmentShader
        .replace(/\( gl_FrontFacing \) \? vIndirectFront : vIndirectBack/g, 'vIndirectFront')
        .replace(/\( gl_FrontFacing \) \? vLightFront : vLightBack/g, 'vLightFront');
    };
    return m;
  }
  // merge indexed or non-indexed geometries that all carry position/normal/color
  function mergeGeos(list) {
    let vc = 0, ic = 0;
    for (const g of list) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3), idx = new Uint32Array(ic);
    let vo = 0, io = 0;
    for (const g of list) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); col.set(g.attributes.color.array, vo * 3);
      if (g.index) { const a = g.index.array; for (let k = 0; k < a.length; k++) idx[io++] = a[k] + vo; }
      else for (let k = 0; k < n; k++) idx[io++] = vo + k;
      vo += n;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3)); out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }
  function paint(g, fn) {
    const p = g.attributes.position, c = new Float32Array(p.count * 3), tmp = new THREE.Color();
    for (let i = 0; i < p.count; i++) { fn(tmp, p.getX(i), p.getY(i), p.getZ(i), i); c[i * 3] = tmp.r; c[i * 3 + 1] = tmp.g; c[i * 3 + 2] = tmp.b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g;
  }

  // grass tuft: curved, tapered blades with V-fold, darker at the root.
  // Returns one geometry per entry of segList: the same blades, with that many segments along each blade.
  function makeTuft(blades, segList) {
    const B = [];
    for (let b = 0; b < blades; b++) {
      const ang = rng() * Math.PI * 2;
      const lean = rand(0.05, 0.42), h = rand(0.62, 1.0), w = rand(0.012, 0.024);
      const ox = rand(-0.07, 0.07), oz = rand(-0.07, 0.07);
      const leanDir = ang + rand(-0.6, 0.6);
      B.push({ lean, h, w, ox, oz, lx: Math.cos(leanDir), lz: Math.sin(leanDir), isDry: rng() < 0.14 });
    }
    return segList.map(n => buildTuft(B, n));
  }
  function buildTuft(B, segs) {
    const pos = [], nor = [], col = [], idx = [];
    const root = lin(0x101a08), mid = lin(0x3c5a1c), tip = lin(0x8aa548), dryTip = lin(0xa8955a);
    let vo = 0;
    for (const { lean, h, w, ox, oz, lx, lz, isDry } of B) {
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, y = t * h * (1 - lean * 0.35 * t * t);
        const off = lean * t * t * h;
        const cx = ox + lx * off, cz = oz + lz * off;
        const hw = i === segs ? 0.0008 : w * Math.pow(1 - t, 0.7);
        // perpendicular to the lean so the blade faces the way it curves
        const px = -lz, pz = lx;
        pos.push(cx - px * hw, y, cz - pz * hw, cx + px * hw, y, cz + pz * hw);
        const nx = lx * 0.45, nz = lz * 0.45; const nl = Math.hypot(nx, 0.9, nz);
        nor.push(nx / nl, 0.9 / nl, nz / nl, nx / nl, 0.9 / nl, nz / nl);
        const c = root.clone().lerp(mid, sstep(t, 0, 0.45)).lerp(isDry ? dryTip : tip, sstep(t, 0.4, 1));
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      for (let i = 0; i < segs; i++) { const a = vo + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      vo += (segs + 1) * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    return g;
  }
  function scatter(count, accept) {
    const out = []; let guard = 0;
    while (out.length < count && guard < count * 20) {
      guard++;
      const x = rand(-34, 34), z = rand(-37, 30);
      if (rng() < accept(x, z)) out.push([x, z]);
    }
    return out;
  }
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  // Instanced vegetation is split into square tiles, each with its own bounding sphere, so the renderer can cull the
  // tiles that are off screen (one InstancedMesh spanning the whole meadow can never be culled, so all of it was drawn
  // every frame). With a lodGeo, tiles beyond lodDist from the camera draw that lighter geometry instead; both levels
  // share one instance buffer, so the swap costs no memory and the blades stay exactly where they were.
  const vegTiles = [];
  function tiledInstances(geo, mat, mats, cols, { cell = 8, lods = [], pad = 0.6 } = {}) {
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const gs = geo.boundingSphere, buckets = new Map();
    mats.forEach((m, i) => {
      const key = Math.floor(m.elements[12] / cell) + ',' + Math.floor(m.elements[14] / cell);
      let b = buckets.get(key); if (!b) buckets.set(key, b = []); b.push(i);
    });
    const c = new THREE.Vector3(), lo = new THREE.Vector3(), hi = new THREE.Vector3();
    for (const idx of buckets.values()) {
      const box = new THREE.Box3();
      const iMat = new THREE.InstancedBufferAttribute(new Float32Array(idx.length * 16), 16);
      const iCol = cols ? new THREE.InstancedBufferAttribute(new Float32Array(idx.length * 3), 3) : null;
      idx.forEach((i, k) => {
        const m = mats[i]; m.toArray(iMat.array, k * 16);
        if (iCol) cols[i].toArray(iCol.array, k * 3);
        const r = gs.radius * m.getMaxScaleOnAxis() + pad; c.copy(gs.center).applyMatrix4(m);
        box.expandByPoint(lo.set(c.x - r, c.y - r, c.z - r)); box.expandByPoint(hi.set(c.x + r, c.y + r, c.z + r));
      });
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const level = (g) => {
        // a light wrapper per tile: shares the attribute buffers, carries the tile's own bounds
        const tg = new THREE.BufferGeometry();
        for (const k in g.attributes) tg.setAttribute(k, g.attributes[k]);
        tg.setIndex(g.index); tg.boundingSphere = sphere;
        const im = new THREE.InstancedMesh(tg, mat, idx.length);
        im.instanceMatrix = iMat; if (iCol) im.instanceColor = iCol;
        im.receiveShadow = true; scene.add(im); return im;
      };
      const levels = [level(geo), ...lods.map(([g]) => { const im = level(g); im.visible = false; return im; })];
      if (lods.length) vegTiles.push({ c: sphere.center, levels, d2: lods.map(([, d]) => d * d), cur: 0, n: idx.length });
    }
  }
  // vegDensity < 1 only on a GPU that can't keep up (see adaptQuality): beyond the first LOD distance a tile then draws
  // just the first part of its instances; they're in random order, so the field thins evenly. Near grass stays full.
  let vegDensity = 1;
  function updateVegLOD(eye) {
    for (const T of vegTiles) {
      const d2 = T.c.distanceToSquared(eye); let k = 0;
      while (k < T.d2.length && d2 > T.d2[k]) k++;
      if (k !== T.cur) { T.levels[T.cur].visible = false; T.levels[k].visible = true; T.cur = k; }
      T.levels[k].count = k ? Math.ceil(T.n * vegDensity) : T.n;
    }
  }
  function instanceField(geo, mat, spots, scaleFn, tintFn, opts) {
    const mats = [], cols = [];
    spots.forEach(([x, z]) => {
      tmpP.set(x, heightAt(x, z) - 0.02, z);
      tmpQ.setFromAxisAngle(UP, rng() * Math.PI * 2);
      scaleFn(tmpS, x, z);
      mats.push(new THREE.Matrix4().compose(tmpP, tmpQ, tmpS));
      const col = new THREE.Color(); tintFn(col, x, z); cols.push(col);
    });
    tiledInstances(geo, mat, mats, cols, opts);
  }
  {
    // main meadow grass (two tuft variants for variety)
    const grassMat = vegMaterial(1.0);
    const [tA, tA3, tA2] = makeTuft(5, [4, 3, 2]), [tB, tB3, tB2] = makeTuft(4, [4, 3, 2]);
    const N = Math.round(110000 * Q);
    const spots = scatter(N, (x, z) => meadowDensity(x, z));
    const half = Math.floor(spots.length / 2);
    const scaleFn = (s, x, z) => {
      const patch = fbm3(x * 0.09, z * 0.09, 1, 3);
      const edge = meadowDensity(x, z);
      const hgt = rand(0.7, 1.15) * (0.55 + patch * 0.75) * (0.5 + 0.5 * edge) * (1 - 0.6 * crashBurn(x, z));
      const wid = rand(0.9, 1.5); s.set(wid, hgt, wid);
    };
    const tintFn = (c, x, z) => {
      const dryness = sstep(fbm3(x * 0.06, z * 0.06, 4, 3), 0.48, 0.68);
      c.setRGB(1, 1, 1).lerp(new THREE.Color(1.25, 1.05, 0.7), dryness * 0.8).multiplyScalar(rand(0.78, 1.18));
      const bn = crashBurn(x, z); if (bn > 0) c.lerp(new THREE.Color(0.32, 0.2, 0.11), bn).multiplyScalar(1 - 0.45 * bn);
    };
    instanceField(tA, grassMat, spots.slice(0, half), scaleFn, tintFn, { lods: [[tA3, 14], [tA2, 30]] });
    instanceField(tB, grassMat, spots.slice(half), scaleFn, tintFn, { lods: [[tB3, 14], [tB2, 30]] });

    // seed-head grass stalks poking above the meadow
    // [full, mid, far]: the same seed heads with fewer facets further away
    const [stalk, stalkMid, stalkLod] = (() => {
      const tilt = [0, 1, 2, 3, 4].map(() => rand(-0.5, 0.5));
      const build = (stemH, hw, hh) => {
        const parts = [];
        const stem = new THREE.CylinderGeometry(0.0025, 0.004, 1, 3, stemH, true); stem.translate(0, 0.5, 0);
        paint(stem, (c, x, y) => c.copy(lin(0x2c3c18)).lerp(lin(0x8a7d4a), y));
        parts.push(stem);
        for (let k = 0; k < 5; k++) {
          const head = new THREE.SphereGeometry(1, hw, hh); head.scale(0.009, 0.05, 0.009);
          head.rotateZ(tilt[k]); head.rotateY(k * 1.3);
          head.translate(Math.sin(k * 1.3) * 0.012, 0.9 + k * 0.03, Math.cos(k * 1.3) * 0.012);
          paint(head, c => c.copy(lin(0xb3a26a)));
          parts.push(head);
        }
        return mergeGeos(parts);
      };
      return [build(3, 5, 4), build(2, 4, 3), build(1, 3, 3)];
    })();
    const stalkSpots = scatter(Math.round(10000 * Q), (x, z) => meadowDensity(x, z) * 0.9);
    instanceField(stalk, vegMaterial(1.4), stalkSpots, s => { const h = rand(0.9, 1.35); s.set(1, h, 1); }, c => c.setRGB(1, 1, 1).multiplyScalar(rand(0.8, 1.15)), { lods: [[stalkMid, 12], [stalkLod, 26]] });

    // small wildflowers (white, pale violet, yellow)
    const flowerGeo = (petal) => {
      const parts = [];
      const stem = new THREE.CylinderGeometry(0.002, 0.003, 1, 3, 2, true); stem.translate(0, 0.5, 0);
      paint(stem, c => c.copy(lin(0x2f4a1c))); parts.push(stem);
      const disc = new THREE.CircleGeometry(0.028, 7); disc.rotateX(-Math.PI / 2); disc.translate(0, 1.0, 0);
      paint(disc, (c, x, y, z) => c.copy(Math.hypot(x, z) < 0.008 ? lin(0xd9a520) : lin(petal))); parts.push(disc);
      return mergeGeos(parts);
    };
    [0xf2efe6, 0xb9a8e6, 0xf0cf4a].forEach((pc, i) => {
      const sp = scatter(Math.round(900 * Q), (x, z) => meadowDensity(x, z) * (0.4 + 0.6 * sstep(fbm3(x * 0.15, z * 0.15, 20 + i, 2), 0.5, 0.7)));
      instanceField(flowerGeo(pc), vegMaterial(1.1), sp, s => { const h = rand(0.35, 0.7); s.set(rand(0.8, 1.3), h, rand(0.8, 1.3)); }, c => c.setRGB(1, 1, 1), { cell: 20 });
    });
  }

  await step('Planting the pines', 0.42);
  // ======================================================================
  // (nearTrees is filled below and used by the squirrels)
  // TREES: procedural conifers (bark trunk + drooping branch tiers), 3 species + far LOD
  // ======================================================================
  function makePine(o) {
    const parts = [];
    const trunk = new THREE.CylinderGeometry(o.topR, o.baseR, 1, 10, 18, true); trunk.translate(0, 0.5, 0);
    const tp = trunk.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i), y = tp.getY(i), z = tp.getZ(i), a = Math.atan2(z, x);
      const flare = 1 + (o.flare ?? 1.8) * Math.pow(1 - sstep(y, 0, 0.05), 2);
      const k = (1 + (vnoise3(Math.cos(a) * 3, y * 25, o.seed) - 0.5) * 0.3) * flare;
      tp.setX(i, x * k); tp.setZ(i, z * k);
    }
    trunk.computeVertexNormals();
    paint(trunk, (c, x, y, z) => { const a = Math.atan2(z, x); const n = vnoise3(Math.cos(a) * 6, y * 60, o.seed + 3);
      c.copy(lin(0x2b211a)).lerp(lin(0x6a5848), n * 0.75).multiplyScalar(0.8 + 0.4 * vnoise3(a * 2, y * 8, 2)); });
    parts.push(trunk);
    for (let w = 0; w < o.whorls; w++) {
      const t = w / (o.whorls - 1);
      const y = o.crown + (o.top - o.crown) * t + rand(-0.006, 0.006);
      const nB = Math.round(rand(o.bMin, o.bMax));
      const len0 = o.spread * Math.pow(1 - t, o.shape) * (0.85 + 0.3 * Math.sin(t * 9 + o.seed)) + 0.02;
      const hue = rand(-0.015, 0.015);
      for (let b = 0; b < nB; b++) {
        const ang = (b / nB) * Math.PI * 2 + w * 0.73 + rand(-0.35, 0.35);
        const L = len0 * rand(0.75, 1.2);
        const droop = o.droop * (1 - t * 0.5) + rand(-0.1, 0.15);
        const g = new THREE.ConeGeometry(L * o.thick, L, 7, 2, true);
        g.translate(0, L / 2, 0);
        // fuzzy, irregular edges
        const gp = g.attributes.position;
        for (let i = 0; i < gp.count; i++) {
          const x = gp.getX(i), yy = gp.getY(i), z = gp.getZ(i);
          const j = (vnoise3(x * 40 + w, yy * 40, z * 40 + b) - 0.5) * L * 0.22;
          gp.setX(i, x + j); gp.setZ(i, z + j * 0.7);
        }
        const shade = rand(0.75, 1.15), tipC = new THREE.Color().setHSL(0.27 + hue, 0.4, 0.3).convertSRGBToLinear();
        paint(g, (c, x, yy) => c.copy(lin(0x0e1c11)).lerp(tipC, Math.pow(yy / L, 0.8)).multiplyScalar(shade));
        g.computeVertexNormals();
        g.rotateZ(-Math.PI / 2);         // point outward along +x
        g.scale(1, 0.42, 1);             // flatten into a tier
        g.rotateZ(-droop);               // droop the tip down
        g.rotateY(ang);
        g.translate(0, y, 0);
        parts.push(g);
      }
    }
    const tipG = new THREE.ConeGeometry(o.spread * 0.12, 0.06, 6, 1, true); tipG.translate(0, o.top + 0.02, 0);
    paint(tipG, c => c.copy(lin(0x1d331c))); parts.push(tipG);
    return mergeGeos(parts);
  }
  const nearTrees = [];
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  treeMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = veg.uTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      #ifdef USE_INSTANCING
        float ph = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.21;
      #else
        float ph = 0.0;
      #endif
      float sway = pow(position.y, 2.0);
      transformed.x += sin(uTime * 0.55 + ph) * 0.006 * sway + sin(uTime * 1.7 + ph * 3.0) * 0.0015 * sway;
      transformed.z += cos(uTime * 0.47 + ph) * 0.004 * sway;`);
  };
  {
    const sp = {
      pine:   { seed: 1, whorls: Math.round(26 * (isSmall ? 0.7 : 1)), bMin: 5, bMax: 7, spread: 0.19, shape: 0.85, droop: 0.32, thick: 0.34, crown: 0.34, top: 0.97, topR: 0.005, baseR: 0.021 },
      spruce: { seed: 2, whorls: Math.round(32 * (isSmall ? 0.7 : 1)), bMin: 6, bMax: 8, spread: 0.23, shape: 1.0, droop: 0.55, thick: 0.38, crown: 0.1, top: 0.98, topR: 0.005, baseR: 0.024 },
      tall:   { seed: 3, whorls: Math.round(20 * (isSmall ? 0.7 : 1)), bMin: 4, bMax: 6, spread: 0.15, shape: 0.7, droop: 0.28, thick: 0.32, crown: 0.46, top: 0.97, topR: 0.004, baseR: 0.018 },
      far:    { seed: 4, whorls: 10, bMin: 4, bMax: 5, spread: 0.22, shape: 0.95, droop: 0.45, thick: 0.45, crown: 0.15, top: 0.97, topR: 0.005, baseR: 0.022 }
    };
    const geos = { pine: makePine(sp.pine), spruce: makePine(sp.spruce), tall: makePine(sp.tall), far: makePine(sp.far) };
    const lists = { pine: [], spruce: [], tall: [], far: [] };
    const placed = [];
    const corridorOpen = (x, z) => (z < -8 && Math.abs(x) < 11 + (-z - 8) * 0.42) || (-z > edgeZ(x) - 1.5 && Math.abs(x) < 60);
    let tries = 0; const want = Math.round((isSmall ? 120 : 210)), wantFar = Math.round(isSmall ? 120 : 260);
    let near = 0, far = 0;
    while ((near < want || far < wantFar) && tries < 30000) {
      tries++;
      const isFar = near >= want;
      const r = isFar ? rand(46, 85) : rand(20.5, 46), a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (corridorOpen(x, z) || inMeadow(x, z, -1.5)) continue;
      { const f = crashField(x, z); if (f.along > 30 && f.along < 80 && Math.abs(f.lat) < 4.6 + (f.along - 30) * 0.05) continue; }
      if (Math.hypot(x - CRASH.snag.x, z - CRASH.snag.z) < 2.6 || Math.hypot(x - CRASH.stump.x, z - CRASH.stump.z) < 2.6) continue;
      const minD = isFar ? 4.2 : 3.1;
      if (placed.some(p => (p[0] - x) ** 2 + (p[1] - z) ** 2 < minD * minD)) continue;
      placed.push([x, z]);
      const h = rand(17, 29) * (r < 24 ? 0.85 : 1);
      const kind = isFar ? 'far' : (rng() < 0.38 ? 'pine' : rng() < 0.6 ? 'spruce' : 'tall');
      lists[kind].push([x, z, h]);
      if (!isFar) nearTrees.push({ x, z, h, crown: sp[kind].crown, baseR: sp[kind].baseR, y0: heightAt(x, z) - 0.15 });
      if (isFar) far++; else near++;
    }
    for (const k in lists) {
      const L = lists[k]; if (!L.length) continue;
      const mats = L.map(([x, z, h]) => {
        tmpP.set(x, heightAt(x, z) - 0.15, z);
        tmpQ.setFromAxisAngle(UP, rng() * Math.PI * 2);
        const w = h * rand(0.88, 1.15); tmpS.set(w, h, w * rand(0.9, 1.1));
        return new THREE.Matrix4().compose(tmpP, tmpQ, tmpS);
      });
      tiledInstances(geos[k], treeMat, mats, null, { cell: k === 'far' ? 24 : 14, pad: 1.5 });
    }
  }

  // ---------- boulders ----------
  const PERCHES = [];   // landing spots on top of the rocks, for the birds
  const perchRay = new THREE.Raycaster();
  function addPerch(m, x, z, s) {
    m.updateMatrixWorld(true);
    perchRay.set(new THREE.Vector3(x + rand(-0.15, 0.15) * s, m.position.y + 5, z + rand(-0.15, 0.15) * s), new THREE.Vector3(0, -1, 0));
    const hit = perchRay.intersectObject(m)[0];
    if (hit) PERCHES.push({ p: hit.point.clone(), taken: null });
  }
  function makeRock(seed) {
    const g = new THREE.IcosahedronGeometry(1, 3);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = 1 + (fbm3(x * 1.4 + seed, y * 1.4, z * 1.4, 4) - 0.5) * 0.75 + (vnoise3(x * 5, y * 5 + seed, z * 5) - 0.5) * 0.08;
      x *= r; y *= r * 0.72; z *= r;
      if (y < -0.25) y = -0.25 + (y + 0.25) * 0.25;
      p.setXYZ(i, x, y, z);
    }
    g.computeVertexNormals();
    paint(g, (c, x, y, z, i) => {
      const n = g.attributes.normal.getY(i);
      c.copy(lin(0x55524b)).lerp(lin(0x7b7769), vnoise3(x * 3, y * 3, z * 3 + seed)).lerp(lin(0x2a3a1a), sstep(n, 0.55, 0.9) * 0.75);
    });
    return g;
  }
  {
    const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const rg = [makeRock(1), makeRock(5), makeRock(9)];
    [[-5.5, -30.2, 1.3], [6.8, -29.6, 0.9], [-7.6, -28.4, 0.55], [9, 4, 0.7], [-11, 7, 1.1], [3, 13, 0.5], [-13, -9, 0.8], [12.5, -12, 1.0], [-2.5, -31.6, 0.45], [4.5, -16, 0.75], [-4, 3.5, 0.6], [7.5, -22, 0.65]].forEach(([x, z, s], i) => {
      OBST.push({ x, z, r: s * 1.15, type: 'rocks' });
      const m = new THREE.Mesh(rg[i % 3], rockMat);
      m.position.set(x, heightAt(x, z) - 0.12 * s, z); m.scale.setScalar(s); m.rotation.y = i * 1.7;
      m.castShadow = true; m.receiveShadow = true; scene.add(m);
      addPerch(m, x, z, s);
    });
  }

  // ---------- the ledge slab: flat top, undercut sides, lichen on top ----------
  {
    const g = new THREE.IcosahedronGeometry(1, 4);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = 1 + (fbm3(x * 1.3 + 3, y * 1.3, z * 1.3, 4) - 0.5) * 0.3;
      x *= r; y *= r; z *= r;
      if (y > 0.28) y = 0.28 + (y - 0.28) * 0.07 + (vnoise3(x * 7, 1, z * 7) - 0.5) * 0.012;
      const under = 0.68 + 0.32 * sstep(y, -0.45, 0.26);
      x *= under; z *= under;
      if (y < -0.5) y = -0.5 + (y + 0.5) * 0.5;
      p.setXYZ(i, x, y, z);
    }
    g.computeVertexNormals();
    paint(g, (c, x, y, z, i) => {
      const ny = g.attributes.normal.getY(i);
      c.copy(lin(0x5a564e)).lerp(lin(0x86816f), vnoise3(x * 4, y * 4, z * 4)).lerp(lin(0x3c4630), sstep(ny, 0.75, 0.95) * 0.35 * vnoise3(x * 9, 0, z * 9) * 2);
    });
    const slab = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    slab.position.set(LEDGE.x, LEDGE.y, LEDGE.z); slab.scale.set(LEDGE.rx, LEDGE.sy, LEDGE.rz);
    slab.castShadow = true; slab.receiveShadow = true; scene.add(slab);
    // a few loose stones around the ledge
    const rockMat2 = new THREE.MeshLambertMaterial({ vertexColors: true });
    const sg = makeRock(21);
    [[-1.5, 0.6, 0.28], [1.6, 0.4, 0.2], [0.9, 1.3, 0.16], [-0.8, 1.5, 0.13]].forEach(([dx, dz, sc], i) => {
      const x = LEDGE.x + dx, z = LEDGE.z + dz;
      OBST.push({ x, z, r: sc * 1.3, type: 'rocks' });
      const m = new THREE.Mesh(sg, rockMat2); m.position.set(x, heightAt(x, z) - 0.05, z); m.scale.setScalar(sc); m.rotation.y = i * 2.1;
      m.castShadow = true; m.receiveShadow = true; scene.add(m);
      addPerch(m, x, z, sc);
    });
  }

  // ---------- low ground mist drifting across the meadow ----------
  const groundMist = (() => {
    const tex = glowTexture(215, 222, 240), list = [];
    const N = isSmall ? 14 : 30;
    for (let i = 0; i < N; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: lin(0x7787a6), transparent: true, opacity: rand(0.05, 0.1), depthWrite: false }));
      let x, z; do { x = rand(-20, 20); z = rand(-30, 18); } while (!inMeadow(x, z, 1));
      m.position.set(x, heightAt(x, z) + rand(0.5, 1.0), z); m.scale.set(rand(9, 16), rand(2.4, 3.6), 1);
      scene.add(m); list.push(m);
    }
    return { update(dt) { list.forEach(m => { m.position.x += 0.16 * dt; m.position.z += 0.07 * dt; if (m.position.x > 22) m.position.x = -22; if (m.position.z > 20) m.position.z = -30; m.position.y = heightAt(m.position.x, m.position.z) + 0.75; }); } };
  })();

  // ---------- fireflies ----------
  const fireflies = (() => {
    const n = Math.round(110 * (isSmall ? 0.6 : 1)), pos = new Float32Array(n * 3), seed = [];
    for (let i = 0; i < n; i++) { const r = rand(2, 22), a = rng() * 6.28; seed.push({ x: Math.cos(a) * r, z: Math.sin(a) * r * 1.2 - 4, y: rand(0.4, 2.4), p: rng() * 6.28, s: rand(0.15, 0.5) }); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ size: 0.13, map: glowTexture(220, 255, 140), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(2.2, 2.8, 1.0) });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false; scene.add(pts);
    return { update(t) {
      for (let i = 0; i < n; i++) { const f = seed[i];
        const x = f.x + Math.sin(t * f.s + f.p) * 1.3, z = f.z + Math.cos(t * f.s * 0.8 + f.p) * 1.3;
        pos[i * 3] = x; pos[i * 3 + 1] = heightAt(x, z) + f.y + Math.sin(t * f.s * 1.7 + f.p * 2) * 0.35; pos[i * 3 + 2] = z; }
      g.attributes.position.needsUpdate = true; mat.opacity = 0.65 + Math.sin(t * 2.1) * 0.25;
    } };
  })();

  await step('Suiting up the astronaut', 0.55);
  // ======================================================================
  // ASTRONAUT (procedural EVA suit)
  // ======================================================================
  const grimeU = { value: 0 };
  function addGrime(mat, strength) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uGround = grimeU;
      sh.vertexShader = 'varying vec3 vWPg;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWPg = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = 'uniform float uGround; varying vec3 vWPg;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        float gh = vWPg.y - uGround;
        float gn = fract(sin(dot(floor(vWPg * 38.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        float grime = (1.0 - smoothstep(0.02, 0.62, gh)) * (0.55 + 0.45 * gn) * ${strength.toFixed(2)};
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.5, 0.42, 0.33), grime);`);
    };
    return mat;
  }
  const M = {
    suit: new THREE.MeshStandardMaterial({ color: lin(0xebe8e0), roughness: 0.86, metalness: 0, normalMap: fabricN, normalScale: new THREE.Vector2(0.55, 0.55), envMap: envTex, envMapIntensity: 0.5 }),
    suitShade: new THREE.MeshStandardMaterial({ color: lin(0xc9c6bd), roughness: 0.9, normalMap: fabricN, normalScale: new THREE.Vector2(0.7, 0.7), envMap: envTex, envMapIntensity: 0.25 }),
    shell: new THREE.MeshStandardMaterial({ color: lin(0xf3f2ee), roughness: 0.28, metalness: 0, envMap: envTex, envMapIntensity: 0.9 }),
    metal: new THREE.MeshStandardMaterial({ color: lin(0xb8bcc3), roughness: 0.32, metalness: 0.95, envMap: envTex, envMapIntensity: 1.2 }),
    anod: new THREE.MeshStandardMaterial({ color: lin(0x3d6fb6), roughness: 0.35, metalness: 0.85, envMap: envTex, envMapIntensity: 1 }),
    anodRed: new THREE.MeshStandardMaterial({ color: lin(0xb03a2e), roughness: 0.4, metalness: 0.8, envMap: envTex, envMapIntensity: 1 }),
    rubber: new THREE.MeshStandardMaterial({ color: lin(0x2a2c30), roughness: 0.95 }),
    grip: new THREE.MeshStandardMaterial({ color: lin(0x7d8794), roughness: 0.8 }),
    boot: new THREE.MeshStandardMaterial({ color: lin(0xd2cfc6), roughness: 0.8, normalMap: fabricN, normalScale: new THREE.Vector2(0.4, 0.4) }),
    hoseBlue: new THREE.MeshStandardMaterial({ color: lin(0x5f8fd0), roughness: 0.55 }),
    hoseWhite: new THREE.MeshStandardMaterial({ color: lin(0xdcd8cf), roughness: 0.6 }),
    orange: new THREE.MeshStandardMaterial({ color: lin(0xd9661f), roughness: 0.7, normalMap: fabricN, normalScale: new THREE.Vector2(0.5, 0.5) }),
    visor: new THREE.MeshStandardMaterial({ color: lin(0xdaa548), roughness: 0.05, metalness: 1, envMap: envTex, envMapIntensity: 1.7 }),
    dark: new THREE.MeshStandardMaterial({ color: lin(0x22252a), roughness: 0.5, metalness: 0.4 }),
    lens: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.3, 2.0) })
  };
  function mk(geo, mat, x = 0, y = 0, z = 0, parent = null, shadow = true) {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true;
    if (parent) parent.add(m); return m;
  }
  // Bake a rig's static parts together. Only a rig's bones (the Groups the animation code moves) ever change pose;
  // every other mesh, however deeply nested in static groups (rings, finger segments, housings), is fixed relative to
  // its nearest bone. So each mesh is re-expressed in its bone's frame and, per bone, meshes sharing a material and
  // shadow settings become one mesh. The rig looks and moves exactly as before with far fewer draw calls, and each
  // call saved is saved again in every shadow pass. The emptied static groups stay in place, so code that reads their
  // positions (the lantern hangs from armR.hand) still works. Meshes in `keep` (shown/hidden at runtime) stay as they are.
  const rigParts = (...xs) => xs.flatMap(x => !x ? [] : x.isObject3D ? [x] : Array.isArray(x) ? rigParts(...x) : Object.values(x).filter(v => v && v.isObject3D));
  function mergeRig(root, { bones = [], keep = [] } = {}) {
    const B = new Set([root, ...bones]), skip = new Set(keep), buckets = new Map();
    root.updateMatrixWorld(true);
    root.traverse(c => {
      if (!c.isMesh || c.isInstancedMesh || c.isSkinnedMesh || c.children.length || skip.has(c) || B.has(c) || Array.isArray(c.material)) return;
      let bone = c.parent, shown = c.visible;
      while (!B.has(bone)) { shown = shown && bone.visible; bone = bone.parent; }
      if (!shown) return;
      const a = c.geometry.attributes, sig = Object.keys(a).sort().map(k => k + a[k].itemSize).join();
      const key = bone.uuid + '|' + c.material.uuid + '|' + c.castShadow + c.receiveShadow + c.renderOrder + c.frustumCulled + '|' + sig;
      let b = buckets.get(key); if (!b) buckets.set(key, b = { bone, list: [] }); b.list.push(c);
    });
    const inv = new THREE.Matrix4();
    for (const { bone, list } of buckets.values()) {
      if (list.length < 2 && list[0].parent === bone) continue;
      inv.copy(bone.matrixWorld).invert();
      const merged = new THREE.Mesh(mergeBaked(list.map(c => [c.geometry, new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld)])), list[0].material);
      merged.castShadow = list[0].castShadow; merged.receiveShadow = list[0].receiveShadow; merged.renderOrder = list[0].renderOrder;
      list.forEach(c => c.parent.remove(c)); bone.add(merged);
    }
    // Shadow passes only care which faces a mesh casts with (its material's shadow side), so per bone and shadow side
    // the casting meshes get one shadow-only copy (positions only), kept on SHADOW_LAYER: the shadow cameras see it,
    // the main camera doesn't. Identical shadows for a fraction of the draws, and the point lights render every
    // caster six times a frame.
    for (const bone of B) {
      const bySide = new Map();
      for (const c of bone.children) {
        if (!c.isMesh || c.isInstancedMesh || !c.castShadow || skip.has(c) || !c.visible || c.children.length || Array.isArray(c.material)) continue;
        const side = c.material.shadowSide !== null ? c.material.shadowSide : SHADOW_SIDE_OF[c.material.side];
        (bySide.get(side) || bySide.set(side, []).get(side)).push(c);
      }
      for (const [side, casters] of bySide) {
        if (casters.length < 2) continue;
        const proxy = new THREE.Mesh(mergeBaked(casters.map(c => { c.updateMatrix(); return [c.geometry, c.matrix]; }), ['position']), shadowProxyMat[side]);
        proxy.castShadow = true; proxy.receiveShadow = false; proxy.layers.set(SHADOW_LAYER);
        casters.forEach(c => { c.castShadow = false; });
        bone.add(proxy);
      }
    }
  }
  const SHADOW_LAYER = 1;
  // what three.js renders in a shadow pass for each material side (when the material sets no shadowSide)
  const SHADOW_SIDE_OF = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
  const shadowProxyMat = Object.fromEntries([THREE.FrontSide, THREE.BackSide, THREE.DoubleSide].map(sd => [sd, new THREE.MeshBasicMaterial({ shadowSide: sd })]));
  function mergeBaked(items, only = null) {
    const parts = items.map(([geo, m]) => {
      let g = geo.clone();
      if (only) for (const k of Object.keys(g.attributes)) if (!only.includes(k)) g.deleteAttribute(k);
      g = g.applyMatrix4(m); const n = g.attributes.position.count;
      if (!g.index) { const ix = new Uint32Array(n); for (let i = 0; i < n; i++) ix[i] = i; g.setIndex(new THREE.BufferAttribute(ix, 1)); }
      if (m.determinant() < 0) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } }
      return g;
    });
    const out = new THREE.BufferGeometry();
    for (const k in parts[0].attributes) {
      const size = parts[0].attributes[k].itemSize, arr = new Float32Array(parts.reduce((n, g) => n + g.attributes[k].count * size, 0));
      let o = 0; for (const g of parts) { arr.set(g.attributes[k].array, o); o += g.attributes[k].count * size; }
      out.setAttribute(k, new THREE.BufferAttribute(arr, size));
    }
    const idx = new Uint32Array(parts.reduce((n, g) => n + g.index.count, 0));
    let io = 0, vo = 0;
    for (const g of parts) { const a = g.index.array; for (let i = 0; i < a.length; i++) idx[io++] = a[i] + vo; vo += g.attributes.position.count; }
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }
  function lathe(pts, segs = 32) {
    const s = pts.slice().sort((a, b) => a[1] - b[1]);
    return new THREE.LatheGeometry(s.map(p => new THREE.Vector2(p[0], p[1])), segs);
  }
  function rbox(w, h, d, r) {
    const s = new THREE.Shape(), x = -w / 2 + r, y = -h / 2 + r, ww = w - 2 * r, hh = h - 2 * r;
    s.moveTo(x, y - r); s.lineTo(x + ww, y - r); s.quadraticCurveTo(x + ww + r, y - r, x + ww + r, y);
    s.lineTo(x + ww + r, y + hh); s.quadraticCurveTo(x + ww + r, y + hh + r, x + ww, y + hh + r);
    s.lineTo(x, y + hh + r); s.quadraticCurveTo(x - r, y + hh + r, x - r, y + hh); s.lineTo(x - r, y); s.quadraticCurveTo(x - r, y - r, x, y - r);
    const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.9, bevelSegments: 3, curveSegments: 5 });
    g.translate(0, 0, -(d - 2 * r) / 2); return g;
  }
  function ring(R, tube, mat, parent, y = 0, sz = 1, x = 0, z = 0) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.scale.z = sz; parent.add(g);
    const t = mk(new THREE.TorusGeometry(R, tube, 8, 40), mat, 0, 0, 0, g); t.rotation.x = Math.PI / 2; return g;
  }

  const astro = new THREE.Group(); scene.add(astro);
  const aBody = new THREE.Group(); astro.add(aBody);
  const pelvis = new THREE.Group(); pelvis.position.y = 0.96; aBody.add(pelvis);
  const torso = new THREE.Group(); pelvis.add(torso);

  // lower torso & upper torso shells
  { const m = mk(lathe([[0, -0.17], [0.13, -0.165], [0.19, -0.12], [0.212, -0.05], [0.214, 0.02]], 36), M.suit, 0, 0, 0, pelvis); m.scale.z = 0.8; }
  { const m = mk(lathe([[0, 0.628], [0.1, 0.62], [0.18, 0.6], [0.24, 0.56], [0.268, 0.5], [0.272, 0.42], [0.258, 0.32], [0.238, 0.22], [0.222, 0.12], [0.216, 0.04], [0.21, -0.02]], 40), M.suit, 0, 0, 0, torso); m.scale.z = 0.78; }
  ring(0.217, 0.021, M.metal, torso, 0.03, 0.8); ring(0.219, 0.009, M.anod, torso, 0.0, 0.8);
  // seams and panels
  for (const y of [0.2, 0.33]) ring(0.25 + (y - 0.2) * 0.12, 0.004, M.suitShade, torso, y, 0.78);
  mk(new THREE.BoxGeometry(0.012, 0.36, 0.01), M.suitShade, 0, 0.27, 0.2, torso);
  // chest display & control module
  const dcm = new THREE.Group(); dcm.position.set(0, 0.36, 0.245); torso.add(dcm);
  mk(rbox(0.3, 0.17, 0.09, 0.02), M.suitShade, 0, 0, 0, dcm);
  {
    const tex = labelTexture(256, 96, (g, w, h) => { g.fillStyle = '#06110a'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#7dff9e'; g.font = 'bold 30px monospace'; g.fillText('O2 94%', 14, 38); g.fillText('P 4.3 PSI', 14, 78);
      g.fillStyle = '#ffb35c'; g.fillRect(200, 20, 36, 10); });
    const scr = mk(new THREE.PlaneGeometry(0.1, 0.038), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.6, 1.6, 1.6) }), -0.055, 0.03, 0.047, dcm, false);
    scr.rotation.x = -0.15;
  }
  [[0.07, 0.035, M.metal], [0.1, -0.03, M.metal], [0.04, -0.035, M.anod], [-0.08, -0.035, M.anodRed]].forEach(([x, y, mat]) => {
    const k = mk(new THREE.CylinderGeometry(0.015, 0.015, 0.025, 16), mat, x, y, 0.05, dcm); k.rotation.x = Math.PI / 2;
  });
  mk(new THREE.BoxGeometry(0.05, 0.012, 0.012), M.orange, -0.1, 0.07, 0.04, dcm);
  // umbilical hoses from chest module to backpack
  function hose(pts, mat, r = 0.019) { const c = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))); return mk(new THREE.TubeGeometry(c, 32, r, 10, false), mat, 0, 0, 0, torso); }
  for (const s of [-1, 1]) {
    hose([[0.15 * s, 0.34, 0.25], [0.26 * s, 0.29, 0.2], [0.31 * s, 0.2, 0.03], [0.28 * s, 0.17, -0.18], [0.23 * s, 0.14, -0.28]], s < 0 ? M.hoseBlue : M.hoseWhite);
    const c1 = mk(new THREE.CylinderGeometry(0.026, 0.026, 0.04, 16), s < 0 ? M.anod : M.anodRed, 0.15 * s, 0.34, 0.25, torso); c1.rotation.z = Math.PI / 2;
    mk(new THREE.CylinderGeometry(0.026, 0.026, 0.035, 16), M.metal, 0.23 * s, 0.14, -0.29, torso).rotation.x = Math.PI / 2;
  }
  // life-support backpack
  const plss = new THREE.Group(); plss.position.set(0, 0.3, -0.33); torso.add(plss);
  mk(rbox(0.5, 0.68, 0.24, 0.04), M.suit, 0, 0, 0, plss);
  mk(rbox(0.44, 0.15, 0.2, 0.025), M.suitShade, 0, -0.39, 0.0, plss);
  mk(new THREE.BoxGeometry(0.46, 0.025, 0.2), M.suitShade, 0, 0.33, 0, plss);
  for (let i = 0; i < 4; i++) mk(new THREE.BoxGeometry(0.008, 0.48, 0.006), M.suitShade, -0.15 + i * 0.1, 0.0, -0.121, plss);
  for (let i = 0; i < 6; i++) mk(new THREE.BoxGeometry(0.16, 0.008, 0.01), M.dark, 0.12, -0.24 + i * 0.022, -0.121, plss);
  mk(new THREE.CylinderGeometry(0.005, 0.005, 0.24, 6), M.metal, -0.19, 0.46, -0.05, plss);
  mk(new THREE.SphereGeometry(0.012, 10, 8), M.dark, -0.19, 0.58, -0.05, plss);
  mk(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 16), M.metal, 0.18, 0.36, 0.0, plss);
  // patches & name tape
  const patchTex = labelTexture(256, 256, (g) => {
    g.fillStyle = '#0f1d38'; g.beginPath(); g.arc(128, 128, 124, 0, 7); g.fill();
    g.strokeStyle = '#ffb35c'; g.lineWidth = 10; g.stroke();
    g.fillStyle = '#e9e4d8'; g.beginPath(); g.arc(150, 112, 46, 0, 7); g.fill();
    g.fillStyle = '#0f1d38'; g.beginPath(); g.arc(170, 100, 40, 0, 7); g.fill();
    g.fillStyle = '#ffb35c'; g.beginPath(); g.moveTo(84, 180); g.lineTo(100, 130); g.lineTo(116, 180); g.fill();
    g.fillStyle = '#e9e4d8'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.fillText('LANTERN · 1', 128, 222);
  });
  const nameTex = labelTexture(256, 64, (g, w, h) => { g.fillStyle = '#d6d2c8'; g.fillRect(0, 0, w, h); g.fillStyle = '#1a1a1a'; g.font = 'bold 38px sans-serif'; g.textAlign = 'center'; g.fillText('EV-1  VEGA', w / 2, 46); });
  { const nt = mk(new THREE.PlaneGeometry(0.12, 0.03), new THREE.MeshStandardMaterial({ map: nameTex, roughness: 0.9 }), 0.13, 0.48, 0.205, torso); nt.rotation.y = 0.35; }

  // neck, helmet, visor assembly
  const neck = new THREE.Group(); neck.position.y = 0.6; torso.add(neck);
  mk(new THREE.CylinderGeometry(0.155, 0.17, 0.06, 32), M.metal, 0, 0.0, 0, neck);
  ring(0.165, 0.012, M.anod, neck, -0.03, 1);
  const head = new THREE.Group(); head.position.y = 0.03; neck.add(head);
  mk(new THREE.SphereGeometry(0.214, 48, 32), M.shell, 0, 0.19, 0, head);
  {
    const W = 2.25, a0 = Math.PI / 2 - W / 2, R = 0.2195, th0 = 0.92, th1 = 2.08;
    const vis = mk(new THREE.SphereGeometry(R, 48, 24, a0, W, th0, th1 - th0), M.visor, 0, 0.19, 0, head, false);
    for (const th of [th0, th1]) {
      const g = new THREE.TorusGeometry(R * Math.sin(th), 0.007, 6, 40, W);
      g.rotateX(Math.PI / 2); g.rotateY(-a0);
      mk(g, M.shell, 0, 0.19 + R * Math.cos(th), 0, head, false);
    }
    // visor hinge bosses and EVA lights
    for (const s of [-1, 1]) {
      const b = mk(new THREE.CylinderGeometry(0.032, 0.032, 0.02, 20), M.shell, 0.215 * s, 0.19, 0.0, head); b.rotation.z = Math.PI / 2;
      const lamp = new THREE.Group(); lamp.position.set(0.17 * s, 0.33, 0.04); head.add(lamp);
      mk(rbox(0.05, 0.035, 0.06, 0.01), M.dark, 0, 0, 0, lamp);
      mk(new THREE.CircleGeometry(0.012, 16), M.lens, -0.01 * s, 0, 0.031, lamp, false);
      mk(new THREE.CircleGeometry(0.012, 16), M.lens, 0.012 * s, 0, 0.031, lamp, false);
    }
    mk(rbox(0.07, 0.03, 0.05, 0.008), M.dark, 0, 0.41, 0.03, head);
  }

  // arms
  function finger(parent, x, y, z, len, curl, r = 0.0105) {
    let p = parent; const segs = [len * 0.55, len * 0.45];
    const g0 = new THREE.Group(); g0.position.set(x, y, z); p.add(g0); p = g0;
    segs.forEach((l, i) => {
      const j = new THREE.Group(); j.rotation.z = curl * (i === 0 ? 0.7 : 1.0); if (i > 0) j.position.y = -segs[i - 1]; p.add(j);
      mk(new THREE.CylinderGeometry(r * (i ? 0.92 : 1), r, l, 10), i ? M.grip : M.suit, 0, -l / 2, 0, j);
      mk(new THREE.SphereGeometry(r * (i ? 0.92 : 1), 10, 8), i ? M.grip : M.suit, 0, -l, 0, j);
      p = j;
    });
  }
  function makeArm(side) {
    const sh = new THREE.Group(); sh.position.set(0.305 * side, 0.5, 0); torso.add(sh);
    mk(new THREE.SphereGeometry(0.108, 24, 16), M.suit, 0, 0, 0, sh);
    const upper = new THREE.Group(); sh.add(upper);
    ring(0.088, 0.016, M.metal, upper, -0.06); ring(0.09, 0.006, M.anod, upper, -0.08);
    mk(lathe([[0.092, -0.07], [0.098, -0.12], [0.094, -0.2], [0.086, -0.27], [0.082, -0.31]], 24), M.suit, 0, 0, 0, upper);
    if (side > 0) { const p = mk(new THREE.CircleGeometry(0.048, 32), new THREE.MeshStandardMaterial({ map: patchTex, roughness: 0.85 }), 0.0985, -0.15, 0, upper, false); p.rotation.y = Math.PI / 2; }
    else mk(new THREE.BoxGeometry(0.004, 0.06, 0.1), M.orange, -0.096, -0.16, 0, upper);
    const elbow = new THREE.Group(); elbow.position.y = -0.31; upper.add(elbow);
    for (let i = 0; i < 3; i++) ring(0.083 - i * 0.002, 0.017, M.suitShade, elbow, -i * 0.032 + 0.01);
    mk(new THREE.SphereGeometry(0.082, 20, 14), M.suitShade, 0, 0, 0, elbow);
    mk(lathe([[0.081, 0.0], [0.08, -0.08], [0.078, -0.14], [0.07, -0.22], [0.064, -0.27], [0.062, -0.305]], 24), M.suit, 0, 0, 0, elbow);
    ring(0.066, 0.014, M.metal, elbow, -0.275); ring(0.067, 0.007, side > 0 ? M.anod : M.anodRed, elbow, -0.292);
    if (side > 0) { mk(rbox(0.07, 0.09, 0.025, 0.006), M.suitShade, 0, -0.18, 0.075, elbow); mk(new THREE.BoxGeometry(0.055, 0.07, 0.006), new THREE.MeshStandardMaterial({ color: lin(0xf1ece0), roughness: 1 }), 0, -0.18, 0.09, elbow); }
    const hand = new THREE.Group(); hand.position.y = -0.3; elbow.add(hand);
    mk(lathe([[0.062, 0], [0.07, -0.025], [0.074, -0.05], [0.05, -0.065]], 20), M.suitShade, 0, 0, 0, hand);
    const palm = new THREE.Group(); palm.position.y = -0.105; hand.add(palm);
    mk(rbox(0.04, 0.095, 0.085, 0.017), M.suit, 0, 0, 0, palm);
    mk(new THREE.BoxGeometry(0.006, 0.08, 0.07), M.grip, -0.021 * side, 0, 0, palm);
    const curl = (side < 0 ? 1.25 : 0.45) * -side;
    [-0.028, -0.009, 0.01, 0.028].forEach((z, i) => finger(palm, -0.006 * side, -0.05, z, [0.062, 0.07, 0.068, 0.056][i], curl));
    { const th = new THREE.Group(); th.position.set(-0.018 * side, -0.015, 0.04); th.rotation.set(0.5, 0, -0.5 * side); palm.add(th); finger(th, 0, 0, 0, 0.055, curl * 0.6, 0.012); }
    return { upper, elbow, hand };
  }
  addGrime(M.suit, 0.9); addGrime(M.suitShade, 0.9); addGrime(M.boot, 1.0);
  const armL = makeArm(1), armR = makeArm(-1);

  // legs
  function makeLeg(side) {
    const hip = new THREE.Group(); hip.position.set(0.112 * side, -0.08, 0); pelvis.add(hip);
    mk(new THREE.SphereGeometry(0.115, 20, 14), M.suit, 0, 0, 0, hip);
    const thigh = new THREE.Group(); hip.add(thigh);
    mk(lathe([[0.115, -0.02], [0.12, -0.1], [0.112, -0.24], [0.1, -0.36], [0.098, -0.445]], 28), M.suit, 0, 0, 0, thigh);
    mk(rbox(0.035, 0.12, 0.1, 0.012), M.suitShade, 0.11 * side, -0.22, 0.02, thigh);
    const knee = new THREE.Group(); knee.position.y = -0.43; thigh.add(knee);
    for (let i = 0; i < 3; i++) ring(0.1 - i * 0.002, 0.019, M.suitShade, knee, 0.03 - i * 0.034);
    mk(new THREE.SphereGeometry(0.1, 22, 16), M.suitShade, 0, 0, 0, knee);
    mk(lathe([[0.097, 0.0], [0.096, -0.08], [0.094, -0.18], [0.086, -0.28], [0.08, -0.35]], 26), M.suit, 0, 0, 0, knee);
    ring(0.085, 0.015, M.metal, knee, -0.345);
    const ankle = new THREE.Group(); ankle.position.y = -0.36; knee.add(ankle);
    const prof = new THREE.Shape();
    prof.moveTo(-0.075, -0.08); prof.lineTo(0.15, -0.08); prof.quadraticCurveTo(0.2, -0.08, 0.195, -0.04);
    prof.quadraticCurveTo(0.19, -0.005, 0.12, 0.01); prof.lineTo(0.06, 0.06); prof.lineTo(0.06, 0.085); prof.lineTo(-0.07, 0.085);
    prof.quadraticCurveTo(-0.095, 0.0, -0.075, -0.08);
    const bg = new THREE.ExtrudeGeometry(prof, { depth: 0.11, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 3, curveSegments: 8 });
    bg.translate(0, 0, -0.055); bg.rotateY(-Math.PI / 2);
    mk(bg, M.boot, 0, 0, 0, ankle);
    mk(rbox(0.15, 0.03, 0.29, 0.01), M.rubber, 0, -0.088, 0.06, ankle);
    for (let i = 0; i < 5; i++) mk(new THREE.BoxGeometry(0.14, 0.008, 0.012), M.rubber, 0, -0.105, -0.06 + i * 0.055, ankle);
    mk(new THREE.BoxGeometry(0.004, 0.03, 0.12), M.orange, 0.078 * side, -0.03, 0.03, ankle);
    return { thigh, knee, ankle };
  }
  const legL = makeLeg(1), legR = makeLeg(-1);

  mergeRig(astro, { bones: rigParts(aBody, pelvis, torso, head, legL, legR, armL, armR) });

  // ======================================================================
  // LANTERN (hurricane style)
  // ======================================================================
  const lantern = new THREE.Group(); scene.add(lantern);
  // shared GLSL: how the lantern's frame shadows its own light (guard wires, air tubes, cap, fuel tank)
  const CAGE_GLSL = `
  float cage(vec3 p){
    vec3 v = uInv * (p - uL); float rh = length(v.xz); float e = atan(v.y, rh); float ph = atan(v.z, v.x);
    float m = (0.35 + 0.65 * smoothstep(1.0, 0.9, e)) * (0.45 + 0.55 * smoothstep(-0.52, -0.38, e));
    float soft = 0.045 + 0.05 * clamp(length(v) / 3.0, 0.0, 1.0);
    for (int k = 0; k < 4; k++) { float a = 0.7854 + float(k) * 1.5708; float d = abs(atan(sin(ph - a), cos(ph - a))); m *= 0.6 + 0.4 * smoothstep(0.022, 0.022 + soft, d); }
    for (int k = 0; k < 2; k++) { float a = float(k) * 3.14159; float d = abs(atan(sin(ph - a), cos(ph - a))); m *= 0.65 + 0.35 * smoothstep(0.035, 0.035 + soft, d); }
    m *= 0.75 + 0.25 * smoothstep(0.01, 0.03, abs(e - 0.26));
    return m;
  }`;
  {
    const paintBlack = new THREE.MeshStandardMaterial({ color: lin(0x1b1a18), roughness: 0.55, metalness: 0.55, envMap: envTex, envMapIntensity: 0.7 });
    const wire = new THREE.MeshStandardMaterial({ color: lin(0x3a3936), roughness: 0.45, metalness: 0.8, envMap: envTex, envMapIntensity: 0.8 });
    const brass = new THREE.MeshStandardMaterial({ color: lin(0xa07a42), roughness: 0.28, metalness: 0.95, envMap: envTex, envMapIntensity: 1.1 });
    const sh = (m) => { m.castShadow = true; return m; };
    // bail with a turned wooden grip
    mk(new THREE.TorusGeometry(0.095, 0.0028, 6, 40, Math.PI), wire, 0, -0.095, 0, lantern, true);
    { const gr = mk(new THREE.CylinderGeometry(0.011, 0.011, 0.06, 14), new THREE.MeshStandardMaterial({ color: lin(0x5a3a22), roughness: 0.7 }), 0, -0.002, 0, lantern, true); gr.rotation.z = Math.PI / 2; }
    // curved side air tubes, the hurricane lantern's signature
    for (const s of [-1, 1]) {
      const pts = [[0.095, -0.098], [0.104, -0.112], [0.1, -0.16], [0.094, -0.24], [0.09, -0.3], [0.084, -0.318]].map(([x, y]) => new THREE.Vector3(x * s, y, 0));
      mk(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.0065, 8), paintBlack, 0, 0, 0, lantern, true);
      mk(new THREE.SphereGeometry(0.0085, 10, 8), paintBlack, 0.095 * s, -0.098, 0, lantern, true);
    }
    mk(new THREE.BoxGeometry(0.2, 0.008, 0.022), paintBlack, 0, -0.114, 0, lantern, true);
    // vented chimney cap
    mk(lathe([[0.0, -0.07], [0.013, -0.071], [0.02, -0.078], [0.022, -0.09], [0.05, -0.097], [0.068, -0.109], [0.073, -0.119], [0.062, -0.124]], 32), paintBlack, 0, 0, 0, lantern, true);
    mk(new THREE.CylinderGeometry(0.026, 0.026, 0.008, 20), paintBlack, 0, -0.068, 0, lantern, true);
    for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; const v = mk(new THREE.CylinderGeometry(0.004, 0.004, 0.006, 8), new THREE.MeshBasicMaterial({ color: 0x050505 }), Math.cos(a) * 0.045, -0.1, Math.sin(a) * 0.045, lantern, false); v.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); }
    // globe: hurricane-shaped glass with soot gathering at the top
    const globePts = [[0.042, -0.128], [0.055, -0.14], [0.066, -0.16], [0.072, -0.19], [0.072, -0.22], [0.066, -0.25], [0.055, -0.27], [0.046, -0.282]];
    const gg = lathe(globePts, 40);
    paint(gg, (c, x, y) => c.setRGB(1, 1, 1).lerp(new THREE.Color(0.25, 0.2, 0.16), sstep(y, -0.17, -0.13) * 0.85));
    const glass = new THREE.MeshStandardMaterial({ vertexColors: true, color: lin(0xfff4e2), roughness: 0.04, metalness: 0, transparent: true, opacity: 0.2, envMap: envTex, envMapIntensity: 1.6,
      emissive: lin(0xff9440), emissiveIntensity: 0.3, side: THREE.DoubleSide, depthWrite: false });
    const gm = mk(gg, glass, 0, 0, 0, lantern, false); gm.renderOrder = 2;
    // wire guard (these really do cast the striped shadows)
    for (let k = 0; k < 4; k++) {
      const a = k / 4 * Math.PI * 2 + Math.PI / 4;
      const pts = globePts.map(([r, y]) => new THREE.Vector3(Math.cos(a) * (r + 0.008), y, Math.sin(a) * (r + 0.008)));
      mk(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0032, 6), wire, 0, 0, 0, lantern, true);
    }
    { const rg = new THREE.TorusGeometry(0.0795, 0.0026, 6, 40); rg.rotateX(Math.PI / 2); mk(rg, wire, 0, -0.205, 0, lantern, true); }
    // brass burner, wick and the wick-raiser knob
    mk(lathe([[0.046, -0.282], [0.05, -0.287], [0.05, -0.296], [0.04, -0.301]], 28), brass, 0, 0, 0, lantern, true);
    { const k1 = mk(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 8), brass, 0.062, -0.293, 0, lantern, true); k1.rotation.z = Math.PI / 2;
      const k2 = mk(new THREE.CylinderGeometry(0.012, 0.012, 0.005, 16), brass, 0.078, -0.293, 0, lantern, true); k2.rotation.z = Math.PI / 2; }
    mk(new THREE.BoxGeometry(0.012, 0.007, 0.0035), new THREE.MeshStandardMaterial({ color: lin(0x0e0c0a), roughness: 1 }), 0, -0.2735, 0, lantern, false);
    // fuel tank: red paint, worn through to bare metal in places
    const ft = lathe([[0.04, -0.3], [0.075, -0.305], [0.092, -0.318], [0.096, -0.33], [0.089, -0.345], [0.06, -0.353], [0.0, -0.355]], 40);
    paint(ft, (c, x, y, z) => { const w = vnoise3(x * 60, y * 60, z * 60), r = vnoise3(x * 25 + 3, y * 25, z * 25);
      c.copy(lin(0x9e231b)).lerp(lin(0x8d8c88), sstep(w, 0.68, 0.78)).lerp(lin(0x5a3018), sstep(r, 0.72, 0.85) * 0.7); });
    mk(ft, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.35, envMap: envTex, envMapIntensity: 0.7 }), 0, 0, 0, lantern, true);
    mk(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 14), brass, -0.06, -0.304, 0, lantern, true);
    // the flame: blue at the root, white-yellow core, orange tip; kept upright by buoyancy
    const flameG = new THREE.Group(); flameG.position.y = -0.272; lantern.add(flameG);
    const fu = { uTime: veg.uTime, uFlick: { value: 1 }, uOn: { value: 1 } };
    const flameShader = (scale, bright) => new THREE.ShaderMaterial({
      uniforms: fu, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `uniform float uTime, uFlick; varying float vH; varying vec3 vN; varying vec3 vV;
        void main(){ vec3 p = position; float h = clamp(p.y / ${(0.06 * scale).toFixed(4)}, 0.0, 1.0); vH = h;
          p.x += (sin(uTime * 21.0 + h * 6.0) * 0.0016 + sin(uTime * 37.0 + h * 11.0) * 0.0009) * h * h * 6.0;
          p.z += cos(uTime * 17.0 + h * 7.0) * 0.0012 * h * h * 6.0;
          p.y *= uFlick;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = normalize(-mv.xyz); vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uOn; varying float vH; varying vec3 vN; varying vec3 vV;
        void main(){ float facing = abs(dot(vN, vV));
          vec3 col = mix(vec3(0.25, 0.45, 2.4), vec3(7.0, 5.4, 2.8), smoothstep(0.05, 0.28, vH));
          col = mix(col, vec3(5.0, 2.6, 0.7), smoothstep(0.35, 0.7, vH)); col = mix(col, vec3(2.2, 0.6, 0.1), smoothstep(0.75, 1.0, vH));
          float a = mix(0.5, 1.0, facing) * (1.0 - smoothstep(0.82, 1.0, vH)) * (0.45 + 0.55 * smoothstep(0.0, 0.14, vH));
          a += pow(1.0 - facing, 2.0) * 0.5 * (1.0 - vH);
          gl_FragColor = vec4(col * a * uOn * ${bright.toFixed(2)}, 1.0); }`
    });
    const flamePts = [[0, 0], [0.007, 0.003], [0.0105, 0.012], [0.011, 0.022], [0.009, 0.034], [0.006, 0.045], [0.003, 0.054], [0, 0.06]];
    const fl = mk(lathe(flamePts, 20), flameShader(1, 0.55), 0, 0, 0, flameG, false); fl.renderOrder = 3;
    const core = mk(lathe(flamePts.map(([r, y]) => [r * 0.5, y * 0.6]), 14), flameShader(0.6, 0.9), 0, 0.004, 0, flameG, false); core.renderOrder = 4;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(255, 190, 110), color: new THREE.Color(2.2, 1.5, 0.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.scale.set(0.16, 0.2, 1); halo.position.y = 0.025; halo.renderOrder = 5; flameG.add(halo);
    // the light itself sits in the flame, so the frame casts real shadows
    const pl = new THREE.PointLight(lin(0xff9a45), 4.6, 26, 2); pl.position.y = 0.022;
    pl.castShadow = true; pl.shadow.mapSize.set(isSmall ? 256 : 1024, isSmall ? 256 : 1024);
    pl.shadow.bias = -0.004; pl.shadow.normalBias = 0.04; pl.shadow.camera.near = 0.12; pl.shadow.camera.far = 26;
    flameG.add(pl);
    lantern.traverse(o => { if (o.isMesh) o.castShadow = false; });
    Object.assign(lantern.userData, { flameG, fu, halo, light: pl, glassMat: glass });
  }
  // light shafts: in-scattering of the lantern's light in the misty air, integrated along each view ray
  const lanternRays = (() => {
    const u = { uL: { value: new THREE.Vector3() }, uInv: { value: new THREE.Matrix3() }, uPow: { value: 0 }, uTime: veg.uTime, uGround: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0.45).normalize() } };
    const m = new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform vec3 uL; uniform mat3 uInv; uniform float uPow, uTime, uGround; uniform vec2 uWind; varying vec3 vW;
        float hsh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float vn3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hsh(i), hsh(i + vec3(1,0,0)), f.x), mix(hsh(i + vec3(0,1,0)), hsh(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(hsh(i + vec3(0,0,1)), hsh(i + vec3(1,0,1)), f.x), mix(hsh(i + vec3(0,1,1)), hsh(i + vec3(1,1,1)), f.x), f.y), f.z); }
        ${CAGE_GLSL}
        void main(){
          vec3 ro = cameraPosition, rd = normalize(vW - cameraPosition);
          float tEnd = 400.0; if (rd.y < -1e-4) tEnd = (uGround - ro.y) / rd.y;
          if (tEnd <= 0.0) discard;
          vec3 lo = uL - ro; float t0 = dot(lo, rd); float h = max(length(lo - rd * t0), 0.012);
          float I = (atan((tEnd - t0) / h) - atan((0.0 - t0) / h)) / h;          // exact integral of 1/d^2 along the ray
          float tA = max(0.0, t0 - 3.2), tB = min(tEnd, t0 + 3.2), sw = 0.0, sm = 0.0;
          for (int i = 0; i < 18; i++) {
            float t = mix(tA, tB, (float(i) + 0.5) / 18.0); vec3 p = ro + rd * t; vec3 d = p - uL; float w = 1.0 / (dot(d, d) + 0.0004);
            float mist = 0.35 + 1.0 * vn3(p * 1.7 + vec3(uWind.x, 0.12, uWind.y) * uTime * 0.35) * (0.5 + vn3(p * 0.45 - uTime * 0.04));
            float cosT = dot(normalize(d), -rd); float g = 0.45; float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
            sw += w; sm += w * cage(p) * mist * hg;
          }
          float k = sw > 0.0 ? sm / sw : 0.0;
          float fade = 1.0 - smoothstep(2.6, 4.6, h);
          gl_FragColor = vec4(vec3(1.0, 0.6, 0.28) * I * k * uPow * fade, 1.0);
        }`
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m); quad.frustumCulled = false; quad.renderOrder = 6; scene.add(quad);
    // dust motes that only sparkle where the lantern light reaches them
    const N = isSmall ? 120 : 320, pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos[i * 3] = rand(-2.2, 2.2); pos[i * 3 + 1] = rand(0.1, 2.4); pos[i * 3 + 2] = rand(-2.2, 2.2); seed[i] = rng(); }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); dg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const du = { uL: u.uL, uInv: u.uInv, uPow: u.uPow, uPR: prU, uTime: veg.uTime };
    const dm = new THREE.ShaderMaterial({ uniforms: du, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `uniform vec3 uL; uniform mat3 uInv; uniform float uPow, uPR, uTime; attribute float aSeed; varying float vB;
        ${CAGE_GLSL}
        void main(){ vec3 d = position - uL; vB = uPow * 9.0 / (dot(d, d) + 0.02) * cage(position) * (0.6 + 0.4 * sin(uTime * (1.0 + aSeed * 3.0) + aSeed * 40.0));
          vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp((1.0 + aSeed * 1.6) * uPR * 4.0 / -mv.z, 1.0, 4.0); }`,
      fragmentShader: `varying float vB; void main(){ float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vec3(1.0, 0.75, 0.45) * vB * a, 1.0); }` });
    const dust = new THREE.Points(dg, dm); dust.frustumCulled = false; dust.renderOrder = 6; scene.add(dust);
    const tq = new THREE.Quaternion(), tm = new THREE.Matrix4(), tl = new THREE.Vector3();
    return {
      update(L, lq, ground, power, dt, t) {
        u.uL.value.copy(L); u.uPow.value = power; u.uGround.value = ground;
        u.uInv.value.setFromMatrix4(tm.makeRotationFromQuaternion(tq.copy(lq).invert()));
        tl.copy(L).sub(camera.position); const dist = Math.max(0.05, tl.length());
        const Dp = Math.max(0.25, dist - 1.0);
        quad.position.copy(camera.position).addScaledVector(tl, Dp / dist);
        quad.quaternion.copy(camera.quaternion);
        const half = Math.min(80, Math.max(4.8 * Dp / dist, Dp * 1.4));
        quad.scale.set(half * 2, half * 2, 1);
        quad.visible = dust.visible = power > 0;
        for (let i = 0; i < N; i++) {
          const k = i * 3, sd = seed[i];
          pos[k] += (Math.sin(t * 0.3 + sd * 50) * 0.05 + 0.04) * dt; pos[k + 1] += Math.sin(t * 0.25 + sd * 30) * 0.03 * dt; pos[k + 2] += (Math.cos(t * 0.27 + sd * 70) * 0.05 + 0.02) * dt;
          for (let a = 0; a < 3; a++) { const c = a === 1 ? L.y - 0.4 : (a === 0 ? L.x : L.z), span = a === 1 ? 1.6 : 2.2; if (pos[k + a] > c + span) pos[k + a] -= span * 2; else if (pos[k + a] < c - span) pos[k + a] += span * 2; }
        }
        dg.attributes.position.needsUpdate = true;
      }
    };
  })();
  // lantern swing: a real pendulum (Verlet with a length constraint) hung from the moving hand
  const lanternPhys = { b: new THREE.Vector3(), bp: new THREE.Vector3(), piv: new THREE.Vector3(), vPrev: new THREE.Vector3(), bFrame: new THREE.Vector3(), acc: new THREE.Vector3(), L: 0.22, init: false, yaw: 0 };

  await step('Waking Kepler', 0.62);
  // ======================================================================
  // DOG — "Kepler", a golden retriever
  // ======================================================================
  const FUR = { gold: lin(0xd39a4c), cream: lin(0xf0d29c), dark: lin(0x9a6230) };
  const furMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, normalMap: furN, normalScale: new THREE.Vector2(0.9, 0.9) });
  const furSolid = (hex) => new THREE.MeshStandardMaterial({ color: lin(hex), roughness: 0.95, normalMap: furN, normalScale: new THREE.Vector2(0.9, 0.9) });
  const goldMat = furSolid(0xd39a4c), creamMat = furSolid(0xeccb94), earMat = furSolid(0xb47634);
  const dog = new THREE.Group(); scene.add(dog);
  const dRoot = new THREE.Group(); dog.add(dRoot);             // rear-hip pivot (for sitting)
  dRoot.position.set(0, 0.5, -0.26);
  const dBody = new THREE.Group(); dBody.position.set(0, -0.5, 0.26); dRoot.add(dBody);
  {
    const g = lathe([[0.0, -0.36], [0.075, -0.35], [0.12, -0.31], [0.145, -0.22], [0.14, -0.1], [0.132, 0.0], [0.148, 0.1], [0.163, 0.2], [0.155, 0.28], [0.118, 0.33], [0.0, 0.355]], 36);
    g.rotateX(Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (y < 0) { y *= 1 + 0.55 * sstep(z, -0.1, 0.22); if (z > -0.24 && z < 0.06) y *= 0.86; }
      x *= 0.82; y *= 1.05;
      p.setXYZ(i, x, y, z);
    }
    g.computeVertexNormals();
    paint(g, (c, x, y, z) => c.copy(FUR.gold).lerp(FUR.cream, sstep(-y, 0.04, 0.14)).lerp(FUR.dark, sstep(y, 0.08, 0.16) * 0.45).multiplyScalar(0.92 + 0.16 * vnoise3(x * 20, y * 20, z * 20)));
    mk(g, furMat, 0, 0.5, 0, dBody);
    // chest feathering
    const ch = mk(new THREE.SphereGeometry(0.1, 16, 12), creamMat, 0, 0.4, 0.25, dBody); ch.scale.set(0.9, 1.0, 0.7);
  }
  // neck + head
  const dNeck = new THREE.Group(); dNeck.position.set(0, 0.6, 0.26); dNeck.rotation.x = 0.8; dBody.add(dNeck);
  mk(new THREE.CylinderGeometry(0.075, 0.105, 0.24, 18), goldMat, 0, 0.1, 0, dNeck);
  ring(0.09, 0.012, new THREE.MeshStandardMaterial({ color: lin(0xa3262a), roughness: 0.6 }), dNeck, 0.06);
  { const tag = mk(new THREE.CylinderGeometry(0.014, 0.014, 0.003, 16), M.metal, 0, 0.04, 0.1, dNeck); tag.rotation.x = Math.PI / 2; }
  const dHead = new THREE.Group(); dHead.position.y = 0.22; dHead.rotation.x = -0.8; dNeck.add(dHead);
  {
    const skull = mk(new THREE.SphereGeometry(0.1, 28, 20), goldMat, 0, 0.035, 0, dHead); skull.scale.set(0.92, 0.86, 1.05);
    const stop = mk(new THREE.SphereGeometry(0.06, 16, 12), goldMat, 0, 0.03, 0.075, dHead); stop.scale.set(1, 0.8, 1);
    const muz = mk(new THREE.CylinderGeometry(0.044, 0.058, 0.13, 18), goldMat, 0, -0.005, 0.12, dHead); muz.rotation.x = Math.PI / 2; muz.scale.z = 0.85;
    mk(new THREE.SphereGeometry(0.044, 16, 12), goldMat, 0, -0.008, 0.183, dHead).scale.set(1, 0.85, 0.8);
    const nose = mk(new THREE.SphereGeometry(0.021, 16, 12), new THREE.MeshStandardMaterial({ color: lin(0x141010), roughness: 0.25, envMap: envTex, envMapIntensity: 0.8 }), 0, 0.012, 0.215, dHead);
    nose.scale.set(1.25, 0.85, 0.85);
    const eyeM = new THREE.MeshStandardMaterial({ color: lin(0x2a170c), roughness: 0.05, envMap: envTex, envMapIntensity: 1.2 });
    for (const s of [-1, 1]) {
      mk(new THREE.SphereGeometry(0.0155, 14, 10), eyeM, 0.047 * s, 0.05, 0.085, dHead, false);
      const lid = mk(new THREE.TorusGeometry(0.016, 0.004, 6, 16), earMat, 0.047 * s, 0.05, 0.083, dHead, false); lid.rotation.y = 0.35 * s;
    }
  }
  const jaw = new THREE.Group(); jaw.position.set(0, -0.035, 0.07); dHead.add(jaw);
  { const j = mk(new THREE.CylinderGeometry(0.035, 0.045, 0.11, 14), creamMat, 0, -0.012, 0.055, jaw); j.rotation.x = Math.PI / 2; j.scale.z = 0.6; }
  const tongue = mk(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshStandardMaterial({ color: lin(0xd8676e), roughness: 0.35 }), 0, -0.01, 0.1, jaw, false);
  tongue.scale.set(0.8, 0.25, 1.4);
  const ears = [];
  for (const s of [-1, 1]) {
    const e = new THREE.Group(); e.position.set(0.085 * s, 0.075, -0.005); e.rotation.z = 0.28 * s; dHead.add(e);
    const m = mk(new THREE.SphereGeometry(0.062, 16, 12), earMat, 0.008 * s, -0.06, 0, e); m.scale.set(0.28, 1, 0.68);
    ears.push(e);
  }
  // legs
  function dogLeg(x, y, z, front) {
    const top = new THREE.Group(); top.position.set(x, y, z); dBody.add(top);
    const L = { top };
    if (front) {
      mk(new THREE.SphereGeometry(0.06, 14, 10), goldMat, 0, -0.02, 0, top).scale.set(0.9, 1.3, 1);
      mk(new THREE.CylinderGeometry(0.043, 0.038, 0.22, 12), goldMat, 0, -0.11, 0, top);
      L.mid = new THREE.Group(); L.mid.position.y = -0.22; top.add(L.mid);
      mk(new THREE.CylinderGeometry(0.034, 0.03, 0.2, 12), goldMat, 0, -0.1, 0, L.mid);
      mk(new THREE.SphereGeometry(0.035, 10, 8), creamMat, 0, -0.06, -0.03, L.mid).scale.set(0.6, 1.6, 0.7);
      L.foot = new THREE.Group(); L.foot.position.y = -0.2; L.mid.add(L.foot);
    } else {
      mk(new THREE.SphereGeometry(0.075, 16, 12), goldMat, 0, -0.07, 0.01, top).scale.set(0.85, 1.55, 1.15);
      L.mid = new THREE.Group(); L.mid.position.y = -0.2; top.add(L.mid);
      mk(new THREE.CylinderGeometry(0.04, 0.032, 0.19, 12), goldMat, 0, -0.095, 0, L.mid);
      mk(new THREE.SphereGeometry(0.04, 10, 8), creamMat, 0, -0.08, -0.03, L.mid).scale.set(0.6, 1.5, 0.8);
      L.hock = new THREE.Group(); L.hock.position.y = -0.19; L.mid.add(L.hock);
      mk(new THREE.CylinderGeometry(0.028, 0.026, 0.12, 10), goldMat, 0, -0.06, 0, L.hock);
      L.foot = new THREE.Group(); L.foot.position.y = -0.125; L.hock.add(L.foot);
    }
    const paw = mk(new THREE.SphereGeometry(0.038, 14, 10), creamMat, 0, -0.012, 0.018, L.foot); paw.scale.set(1, 0.6, 1.35);
    return L;
  }
  const fl = dogLeg(0.07, 0.47, 0.22, true), fr = dogLeg(-0.07, 0.47, 0.22, true);
  const hl = dogLeg(0.075, 0.5, -0.26, false), hr = dogLeg(-0.075, 0.5, -0.26, false);
  // feathered tail
  const tailSegs = [];
  {
    let parent = new THREE.Group(); parent.position.set(0, 0.55, -0.35); parent.rotation.x = -2.1; dBody.add(parent);
    for (let i = 0; i < 7; i++) {
      const seg = new THREE.Group(); if (i) seg.position.y = 0.055; parent.add(seg);
      const r = 0.03 - i * 0.003;
      mk(new THREE.SphereGeometry(r, 10, 8), goldMat, 0, 0.03, 0, seg).scale.set(1, 1.6, 1);
      const fe = mk(new THREE.SphereGeometry(r * 1.4, 10, 8), creamMat, 0, 0.03, -r * 0.9, seg); fe.scale.set(0.5, 1.5, 0.9);
      tailSegs.push(seg); parent = seg;
    }
  }
  dog.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  mergeRig(dog, { bones: rigParts(dRoot, dNeck, dHead, jaw, ears, fl, fr, hl, hr, tailSegs), keep: [tongue] });

  await step('Landing the wreck', 0.66);
  // ======================================================================
  // CRASHED SPACECRAFT: hull broken in two, torn ribs and cables, burning, sparking
  // ======================================================================
  const wreck = (() => {
    const W = {};
    const panelN = normalMapFrom(256, (x, y) => {
      const cx = x % 64, cy = y % 40; let h = (cx < 2 || cy < 2) ? -1 : 0;
      const k = Math.floor(x / 64) * 7 + Math.floor(y / 40);
      if (hash3(k, 3, 1) > 0.5 && Math.abs(cx - 32) < 1) h = -1;
      if ((cx - 6) ** 2 + (cy - 6) ** 2 < 3 || (cx - 58) ** 2 + (cy - 6) ** 2 < 3) h = 0.7;
      return h + vnoise3(x * 0.2, y * 0.2, 4) * 0.3;
    }, 1.6);
    panelN.repeat.set(10, 3);
    const panelN2 = panelN.clone(); panelN2.needsUpdate = true; panelN2.repeat.set(0.6, 0.6);
    // painted hull: u runs around the hull (0 = belly, 0.5 = spine), v runs tail (0) to nose (1)
    function makeHullTextures() {
      const TW = isSmall ? 512 : 1024, TH = TW / 2;
      const mkC = () => { const c = document.createElement('canvas'); c.width = TW; c.height = TH; return [c, c.getContext('2d')]; };
      const [cA, A] = mkC(), [cR, R] = mkC(), [cH, Hh] = mkC();
      const X = u => u * TW, Y = v => (1 - v) * TH;
      const both = (fn) => { fn(A, 'a'); fn(R, 'r'); fn(Hh, 'h'); };
      A.fillStyle = '#c9ccd0'; A.fillRect(0, 0, TW, TH); R.fillStyle = '#c4c4c4'; R.fillRect(0, 0, TW, TH); Hh.fillStyle = '#808080'; Hh.fillRect(0, 0, TW, TH);
      // white blanket panels on the upper hull, each a slightly different tone
      const pw = TW / 28, ph = TH / 12;
      for (let i = 0; i < 28; i++) for (let j = 0; j < 12; j++) { const s = 190 + Math.floor(rng() * 18); A.fillStyle = `rgb(${s},${s + 2},${s + 5})`; A.fillRect(i * pw, j * ph, pw, ph); }
      A.strokeStyle = 'rgba(60,64,70,0.6)'; Hh.strokeStyle = '#2a2a2a'; A.lineWidth = Hh.lineWidth = Math.max(1, TW / 900);
      for (let i = 0; i <= 28; i++) [A, Hh].forEach(g => { g.beginPath(); g.moveTo(i * pw, 0); g.lineTo(i * pw, TH); g.stroke(); });
      for (let j = 0; j <= 12; j++) [A, Hh].forEach(g => { g.beginPath(); g.moveTo(0, j * ph); g.lineTo(TW, j * ph); g.stroke(); });
      for (let k = 0; k < 120; k++) { const x = Math.floor(rng() * 28) * pw, y = Math.floor(rng() * 12) * ph + ph / 2; [A, Hh].forEach(g => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + pw, y); g.stroke(); }); }
      // black thermal tiles on the belly, with gaps and odd replacement tiles
      const tile = TW / 140;
      const tileBand = (u0, u1) => {
        A.fillStyle = '#07080a'; A.fillRect(X(u0), 0, X(u1) - X(u0), TH); R.fillStyle = '#e6e6e6'; R.fillRect(X(u0), 0, X(u1) - X(u0), TH);
        Hh.fillStyle = '#303030'; Hh.fillRect(X(u0), 0, X(u1) - X(u0), TH);
        for (let x = X(u0); x < X(u1); x += tile) for (let y = 0; y < TH; y += tile) {
          const odd = rng() < 0.03, sh = odd ? 58 + rng() * 20 : 20 + rng() * 22;
          A.fillStyle = `rgb(${sh | 0},${(sh + 1) | 0},${(sh + 3) | 0})`; A.fillRect(x + 0.6, y + 0.6, tile - 1.2, tile - 1.2);
          Hh.fillStyle = '#8a8a8a'; Hh.fillRect(x + 0.6, y + 0.6, tile - 1.2, tile - 1.2);
          R.fillStyle = `rgb(${200 + rng() * 40 | 0},0,0)`.replace(/rgb\((\d+),0,0\)/, (m, a) => `rgb(${a},${a},${a})`); R.fillRect(x, y, tile, tile);
        }
      };
      tileBand(0, 0.215); tileBand(0.785, 1);
      // quilted blanket strip along the chines
      [[0.215, 0.248], [0.752, 0.785]].forEach(([u0, u1]) => {
        A.fillStyle = '#b8b3a6'; A.fillRect(X(u0), 0, X(u1) - X(u0), TH);
        for (let y = 0; y < TH; y += tile * 2) { A.strokeStyle = 'rgba(90,86,78,0.7)'; A.strokeRect(X(u0), y, X(u1) - X(u0), tile * 2); }
      });
      // black cockpit surround and nose cap
      A.fillStyle = '#16171a'; A.beginPath(); A.ellipse(X(0.5), Y(0.855), X(0.15), TH * 0.07, 0, 0, Math.PI * 2); A.fill();
      A.fillRect(0, 0, TW, Y(0.965)); R.fillStyle = '#b0b0b0'; R.fillRect(0, 0, TW, Y(0.965));
      // cargo-bay doors along the spine of the rear hull
      [0.385, 0.5, 0.615].forEach(u => [A, Hh].forEach(g => { g.lineWidth = u === 0.5 ? 2.5 : 2; g.strokeStyle = g === A ? 'rgba(40,42,46,0.85)' : '#101010'; g.beginPath(); g.moveTo(X(u), Y(0.04)); g.lineTo(X(u), Y(0.455)); g.stroke(); }));
      for (let k = 0; k < 14; k++) { A.fillStyle = '#5d6168'; A.fillRect(X(0.5) - 3, Y(0.06 + k * 0.028), 6, 3); }
      // thruster port clusters
      const ports = (u, v) => { for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { A.fillStyle = '#0b0b0c'; A.beginPath(); A.arc(X(u) + i * tile * 1.6, Y(v) + j * tile * 1.6, tile * 0.55, 0, 7); A.fill(); Hh.fillStyle = '#000'; Hh.beginPath(); Hh.arc(X(u) + i * tile * 1.6, Y(v) + j * tile * 1.6, tile * 0.55, 0, 7); Hh.fill(); } };
      ports(0.3, 0.9); ports(0.68, 0.9); ports(0.33, 0.05); ports(0.64, 0.05);
      // side hatch with hinge and rescue marking
      [A, Hh].forEach(g => { g.lineWidth = 2.5; g.strokeStyle = g === A ? '#3a3d42' : '#101010'; g.beginPath(); g.arc(X(0.27), Y(0.63), TH * 0.05, 0, 7); g.stroke(); });
      A.fillStyle = '#d9b02a'; A.fillRect(X(0.27) + TH * 0.06, Y(0.63) - 4, TH * 0.05, 8);
      // name, stripe and stencils (text runs tail → nose)
      [[0.29, 1], [0.71, -1]].forEach(([u, sgn]) => {
        A.save(); A.translate(X(u), Y(0.12)); A.rotate(-Math.PI / 2 * sgn); A.fillStyle = '#1b1d21'; A.font = `bold ${Math.round(TH * 0.055)}px sans-serif`; A.fillText('VESPER II', 0, 0);
        A.font = `${Math.round(TH * 0.018)}px sans-serif`; A.fillText('UNITED ORBITAL SURVEY · OV-2', 0, TH * 0.03); A.restore();
        A.fillStyle = '#c95a1a'; A.fillRect(X(u + 0.022 * sgn) - 2, Y(0.46), 4, Y(0.04) - Y(0.46));
      });
      A.fillStyle = 'rgba(30,30,30,0.7)'; A.font = `${Math.round(TH * 0.016)}px sans-serif`;
      for (let k = 0; k < 10; k++) A.fillText(rng() < 0.5 ? 'NO STEP' : 'RESCUE ⟶', X(rand(0.3, 0.7)), Y(rand(0.1, 0.8)));
      // weathering: soot streaks dragged aft from the break and the nose
      for (let k = 0; k < 340; k++) {
        const v0 = rng() < 0.55 ? rand(0.47, 0.56) : rand(0.8, 0.97), u0 = rng(), len = rand(0.03, 0.22);
        const x0 = X(u0), y0 = Y(v0), x1 = x0 + rand(-6, 6), y1 = Y(v0 - len);
        const gr = A.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, `rgba(8,7,6,${rand(0.15, 0.5)})`); gr.addColorStop(1, 'rgba(8,7,6,0)');
        A.strokeStyle = gr; A.lineWidth = rand(1, TW / 160); A.beginPath(); A.moveTo(x0, y0); A.lineTo(x1, y1); A.stroke();
        R.strokeStyle = 'rgba(240,240,240,0.4)'; R.lineWidth = A.lineWidth; R.beginPath(); R.moveTo(x0, y0); R.lineTo(x1, y1); R.stroke();
      }
      // scorch around the break and the crumpled nose
      const scorch = (u, v, r, a) => { const gr = A.createRadialGradient(X(u), Y(v), 0, X(u), Y(v), r); gr.addColorStop(0, `rgba(10,7,4,${a})`); gr.addColorStop(0.6, `rgba(40,24,10,${a * 0.5})`); gr.addColorStop(1, 'rgba(40,24,10,0)'); A.fillStyle = gr; A.beginPath(); A.arc(X(u), Y(v), r, 0, 7); A.fill(); };
      for (let k = 0; k < 70; k++) scorch(rng(), rand(0.4, 0.56), rand(TH * 0.03, TH * 0.12), rand(0.3, 0.8));
      for (let k = 0; k < 40; k++) scorch(rng(), rand(0.86, 1.0), rand(TH * 0.03, TH * 0.1), rand(0.3, 0.7));
      // heat-tint bands (bronze → violet → blue) near the torn edges
      [[0.455, -1], [0.5, 1]].forEach(([v, sgn]) => ['rgba(140,100,50,0.45)', 'rgba(80,58,110,0.45)', 'rgba(50,80,130,0.4)'].forEach((c, i) => {
        A.fillStyle = c; for (let x = 0; x < TW; x += 4) { const vv = v + sgn * (0.012 + i * 0.012) + (vnoise3(x * 0.03, i, v * 9) - 0.5) * 0.02; A.fillRect(x, Y(vv), 4, TH * 0.012); } }));
      // missing tiles near the nose and break exposing felt underlayer / bare aluminium
      for (let k = 0; k < 60; k++) { const u = rng() < 0.5 ? rand(0, 0.2) : rand(0.8, 1), v = rng() < 0.5 ? rand(0.42, 0.56) : rand(0.85, 0.97);
        A.fillStyle = rng() < 0.6 ? '#cfc4a6' : '#8f9398'; A.fillRect(X(u), Y(v), tile * Math.ceil(rand(1, 3)), tile * Math.ceil(rand(1, 3))); }
      // mud and grass smeared on the belly from ploughing in
      for (let k = 0; k < 900; k++) { const u = rng() < 0.5 ? rand(0, 0.18) : rand(0.82, 1), v = rand(0.5, 1) ** 0.6; A.fillStyle = `rgba(${60 + rng() * 30 | 0},${45 + rng() * 25 | 0},${28 + rng() * 15 | 0},${rand(0.2, 0.7)})`; A.fillRect(X(u), Y(v), rand(1, 6), rand(1, 5)); }
      // scratches
      for (let k = 0; k < 160; k++) { const x = rng() * TW, y = rng() * TH, a = rand(-0.4, 0.4) + Math.PI / 2, L = rand(5, 40); A.strokeStyle = `rgba(${rng() < 0.5 ? '235,236,238' : '40,40,42'},0.5)`; A.lineWidth = 1; A.beginPath(); A.moveTo(x, y); A.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); A.stroke(); }
      // rivets in the height map
      Hh.fillStyle = '#c8c8c8'; for (let i = 0; i <= 28; i++) for (let y = 0; y < TH; y += tile * 1.5) Hh.fillRect(i * pw + 2, y, 1.5, 1.5);
      // build textures
      const map = new THREE.CanvasTexture(cA); map.encoding = THREE.sRGBEncoding; map.anisotropy = 8;
      const rough = new THREE.CanvasTexture(cR); rough.anisotropy = 8;
      const hd = Hh.getImageData(0, 0, TW, TH).data, nc = document.createElement('canvas'); nc.width = TW; nc.height = TH;
      const ng = nc.getContext('2d'), img = ng.createImageData(TW, TH);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        const h = (xx, yy) => hd[(((yy + TH) % TH) * TW + ((xx + TW) % TW)) * 4] / 255;
        let nx = (h(x - 1, y) - h(x + 1, y)) * 1.6, ny = (h(x, y - 1) - h(x, y + 1)) * 1.6; const l = Math.hypot(nx, ny, 1);
        const i = (y * TW + x) * 4; img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
      }
      ng.putImageData(img, 0, 0);
      const normal = new THREE.CanvasTexture(nc); normal.anisotropy = 8;
      return { map, rough, normal };
    }
    const HT = makeHullTextures();
    const heatU = { value: 1 };
    const withHeat = (m) => { m.onBeforeCompile = (sh) => {
      sh.uniforms.uHeat = heatU;
      sh.vertexShader = 'attribute float aHeat; varying float vHeat;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vHeat = aHeat;');
      sh.fragmentShader = 'uniform float uHeat; varying float vHeat;\n' + sh.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= 1.0 - 0.85 * smoothstep(0.0, 0.6, vHeat);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vec3(5.0, 1.35, 0.22) * pow(clamp(vHeat, 0.0, 1.0), 3.5) * uHeat;');
    }; return m; };
    const hullMat = withHeat(new THREE.MeshStandardMaterial({ map: HT.map, roughnessMap: HT.rough, normalMap: HT.normal, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 1, metalness: 0.04, envMap: envTex, envMapIntensity: 0.3, side: THREE.DoubleSide }));
    const foilN = normalMapFrom(128, (x, y) => Math.abs(fbm3(x / 128 * 9, y / 128 * 9, 7, 4) - 0.5) * 4 + vnoise3(x / 128 * 40, y / 128 * 40, 2) * 0.5, 3.5);
    foilN.repeat.set(6, 4);
    const foilMat = new THREE.MeshStandardMaterial({ color: lin(0xc8993c), metalness: 1, roughness: 0.32, normalMap: foilN, normalScale: new THREE.Vector2(1.2, 1.2), envMap: envTex, envMapIntensity: 1.1, side: THREE.BackSide });
    // wings and fin: texture laid out in metres of the wing plan
    const wingTex = (() => {
      const S = 512, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
      const PX = x => x / 3.8 * S, PY = y => (1 - (y + 0.5) / 4.2) * S;
      g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 16; i++) for (let j = 0; j < 18; j++) { const s = 222 + rng() * 26 | 0; g.fillStyle = `rgb(${s},${s},${s + 3})`; g.fillRect(i * S / 16, j * S / 18, S / 16, S / 18); }
      g.strokeStyle = 'rgba(80,84,90,0.7)'; g.lineWidth = 1;
      for (let i = 0; i <= 16; i++) { g.beginPath(); g.moveTo(i * S / 16, 0); g.lineTo(i * S / 16, S); g.stroke(); }
      for (let j = 0; j <= 18; j++) { g.beginPath(); g.moveTo(0, j * S / 18); g.lineTo(S, j * S / 18); g.stroke(); }
      // elevons along the trailing edge
      g.strokeStyle = 'rgba(30,32,36,0.9)'; g.lineWidth = 3;
      g.strokeRect(PX(0.3), PY(0.4), PX(1.5) - PX(0.3), PY(-0.4) - PY(0.4)); g.strokeRect(PX(1.85), PY(0.4), PX(3.3) - PX(1.85), PY(-0.4) - PY(0.4));
      // dark carbon leading edge
      g.strokeStyle = '#1a1a1c'; g.lineWidth = S * 0.05; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(PX(0), PY(3.6)); g.lineTo(PX(1.2), PY(3.0)); g.lineTo(PX(3.4), PY(0.9)); g.lineTo(PX(3.6), PY(0.1)); g.stroke();
      for (let k = 0; k < 140; k++) { const x0 = PX(rand(0, 3.5)), y0 = PY(rand(0, 3.5)); const gr = g.createLinearGradient(x0, y0, x0, y0 + rand(20, 120)); gr.addColorStop(0, `rgba(10,8,6,${rand(0.15, 0.5)})`); gr.addColorStop(1, 'rgba(10,8,6,0)'); g.strokeStyle = gr; g.lineWidth = rand(1, 7); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + rand(-4, 4), y0 + rand(20, 120)); g.stroke(); }
      for (let k = 0; k < 25; k++) { const x = PX(rand(0, 3.4)), y = PY(rand(-0.3, 3.4)), r = rand(10, 50); const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(15,10,6,0.65)'); gr.addColorStop(1, 'rgba(15,10,6,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / 3.8, 1 / 4.2); t.offset.set(0, 0.5 / 4.2); return t;
    })();
    const wingMat = new THREE.MeshStandardMaterial({ map: wingTex, vertexColors: true, roughness: 0.8, metalness: 0.04, envMap: envTex, envMapIntensity: 0.3, side: THREE.DoubleSide });
    const partMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.4, normalMap: panelN2, normalScale: new THREE.Vector2(0.6, 0.6), envMap: envTex, envMapIntensity: 0.6, side: THREE.DoubleSide });
    const darkMetal = new THREE.MeshStandardMaterial({ color: lin(0x3e4044), roughness: 0.45, metalness: 0.85, envMap: envTex, envMapIntensity: 0.8 });
    const innerMat = new THREE.MeshStandardMaterial({ color: lin(0x0b0b0c), roughness: 0.9, side: THREE.DoubleSide });
    const glassMat = new THREE.MeshStandardMaterial({ color: lin(0x05070a), roughness: 0.06, metalness: 0.9, envMap: envTex, envMapIntensity: 1.4 });

    const prof = [[0.92, 0], [1.05, 0.3], [1.12, 1.5], [1.12, 5], [1.08, 6.5], [0.95, 7.6], [0.72, 8.5], [0.42, 9.1], [0.12, 9.38], [0.0, 9.42]];
    const rAt = y => { if (y <= 0) return prof[0][0]; for (let i = 1; i < prof.length; i++) if (prof[i][1] >= y) { const a = prof[i - 1], b = prof[i], t = (y - a[1]) / (b[1] - a[1]); return a[0] + (b[0] - a[0]) * t; } return 0; };
    const deform = (x, y, z) => {
      const ang = Math.atan2(x, z);
      let k = 1 - (vnoise3(x * 1.5, y * 1.2, z * 1.5) - 0.5) * 0.06;
      if (y > 7.6) k -= sstep(y, 7.6, 9.4) * vnoise3(ang * 3, y * 2.5, 9) * 0.28;
      x *= k * 1.06; z *= k;
      if (z > 0.62) z = 0.62 + (z - 0.62) * 0.45;
      return [x, y, z, ang];
    };
    const hullColor = (c, x, y, z) => {
      const tile = hash3(Math.floor(x * 4 + 50), Math.floor(z * 4 + 50), 2);
      c.copy(lin(0xd2d5d8)).lerp(lin(0x1c1d20).multiplyScalar(0.85 + tile * 0.3), sstep(-y, 0.25, 0.5));
      c.multiplyScalar(1 - 0.45 * sstep(fbm3(x * 2.5, y * 2.5, z * 0.35, 3), 0.45, 0.75));
      const nb = 1 - sstep(Math.abs(z - 4.5), 0.3, 1.8);
      c.lerp(new THREE.Color(0.1, 0.06, 0.035), nb * 0.75).lerp(lin(0x2c3148), nb * (1 - nb) * 1.1);
      c.lerp(lin(0x120f0d), sstep(z, 7.4, 9.2) * 0.7);
    };
    function hullPart(y0, y1, closeStart, closeEnd) {
      const ys = new Set(); for (let y = y0; y <= y1 + 1e-6; y += 0.3) ys.add(+y.toFixed(3)); ys.add(y1);
      prof.forEach(q => { if (q[1] > y0 && q[1] < y1) ys.add(q[1]); });
      const rows = [...ys].sort((a, b) => a - b).map(y => [Math.max(0.001, rAt(y)), y]);
      if (closeStart) rows.unshift([0, y0 - 0.0005]);
      if (closeEnd && rows[rows.length - 1][0] > 0.002) rows.push([0, y1 + 0.0005]);
      const g = new THREE.LatheGeometry(rows.map(q => new THREE.Vector2(q[0], q[1])), 48);
      const P = g.attributes.position, UV = g.attributes.uv, nr = rows.length, heat = new Float32Array(P.count);
      for (let i = 0; i < P.count; i++) {
        const j = i % nr; UV.setY(i, Math.min(1, Math.max(0, rows[j][1] / 9.42)));
        if (!closeStart) heat[i] = j === 0 ? 1 : j === 1 ? 0.3 : 0;
        if (!closeEnd) heat[i] = j === nr - 1 ? 1 : j === nr - 2 ? 0.3 : heat[i];
      }
      g.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1));
      for (let i = 0; i < P.count; i++) {
        let x = P.getX(i), y = P.getY(i), z = P.getZ(i), ang = Math.atan2(x, z);
        if (!closeStart && Math.abs(y - y0) < 1e-3) y += (vnoise3(ang * 2.2, 1, y0) - 0.3) * 0.55 + Math.max(0, Math.sin(ang * 3 + 1)) * 0.25;
        if (!closeEnd && Math.abs(y - y1) < 1e-3) y -= (vnoise3(ang * 2.2, 5, y1) - 0.3) * 0.55 + Math.max(0, Math.sin(ang * 2.5)) * 0.25;
        const d = deform(x, y, z); P.setXYZ(i, d[0], d[1], d[2]);
      }
      g.computeVertexNormals(); g.rotateX(Math.PI / 2); paint(g, hullColor);
      return g;
    }
    const f = { x: -CRASH.dir.x, z: -CRASH.dir.z };
    W.root = new THREE.Group(); W.root.position.set(CRASH.c.x, 0, CRASH.c.z); W.root.rotation.y = Math.atan2(f.x, f.z); scene.add(W.root);
    const gAt = (lx, lz) => { const wx = CRASH.c.x + f.x * lz + CRASH.perp.x * lx, wz = CRASH.c.z + f.z * lz + CRASH.perp.z * lx; return heightAt(wx, wz); };
    // front section (break → nose)
    const front = new THREE.Group(); front.position.set(0.15, gAt(0.15, 0.35) + 0.62, 0.35); front.rotation.set(0.11, 0.05, 0.16); W.root.add(front);
    { const g = hullPart(4.55, 9.42, false, true); g.translate(0, 0, -4.55); mk(g, hullMat, 0, 0, 0, front); }
    { // cockpit windows
      const rows = []; for (let y = 7.75; y <= 8.56; y += 0.1) rows.push(new THREE.Vector2(rAt(y) + 0.016, y));
      const g = new THREE.LatheGeometry(rows, 16, Math.PI - 0.85, 1.7); const P = g.attributes.position;
      for (let i = 0; i < P.count; i++) { const d = deform(P.getX(i), P.getY(i), P.getZ(i)); P.setXYZ(i, d[0], d[1], d[2]); }
      g.computeVertexNormals(); g.rotateX(Math.PI / 2); g.translate(0, 0, -4.55); mk(g, glassMat, 0, 0, 0, front);
    }
    // rear section (tail → break)
    const rear = new THREE.Group(); rear.position.set(-0.25, gAt(-0.25, -0.6) + 0.62, -0.6); rear.rotation.set(-0.04, 0.32, -0.22); W.root.add(rear);
    { const g = hullPart(0, 4.45, true, false); g.translate(0, 0, -4.45); mk(g, hullMat, 0, 0, 0, rear); }
    // crumpled gold insulation lining the inside of both halves
    function foilPart(y0, y1, cutAtStart) {
      const rows = []; for (let y = y0; y <= y1 + 1e-6; y += 0.35) rows.push(new THREE.Vector2(Math.max(0.01, rAt(y) * 0.93), y));
      const g = new THREE.LatheGeometry(rows, 40); const P = g.attributes.position;
      for (let i = 0; i < P.count; i++) {
        let x = P.getX(i), y = P.getY(i), z = P.getZ(i), ang = Math.atan2(x, z);
        const cut = cutAtStart ? Math.abs(y - y0) < 1e-3 : Math.abs(y - rows[rows.length - 1].y) < 1e-3;
        if (cut) y += (cutAtStart ? 1 : -1) * (0.12 + vnoise3(ang * 3, 2, y0) * 0.35);
        const k = 1 + (vnoise3(x * 6, y * 6, z * 6) - 0.5) * 0.08; const d = deform(x * k, y, z * k); P.setXYZ(i, d[0], d[1], d[2]);
      }
      g.computeVertexNormals(); g.rotateX(Math.PI / 2); return g;
    }
    { const g = foilPart(4.6, 8.6, true); g.translate(0, 0, -4.55); mk(g, foilMat, 0, 0, 0, front, false); }
    { const g = foilPart(0.25, 4.4, false); g.translate(0, 0, -4.45); mk(g, foilMat, 0, 0, 0, rear, false); }
    // torn skin flaps peeled back around the break, glowing at their ragged tips
    function petalGeo(w, L, curl) {
      const g = new THREE.PlaneGeometry(w, L, 3, 6); g.translate(0, L / 2, 0);
      const P = g.attributes.position, heat = new Float32Array(P.count);
      for (let i = 0; i < P.count; i++) {
        let x = P.getX(i), y = P.getY(i); const t = y / L;
        const z = t * t * curl * L + Math.sin(x * 9 + t * 4) * 0.025;
        x *= 1 - t * 0.45 + (vnoise3(x * 9, y * 9, w) - 0.5) * 0.4 * t;
        P.setXYZ(i, x, y, z); heat[i] = Math.pow(t, 2.2) * 0.9;
      }
      g.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1)); g.computeVertexNormals(); return g;
    }
    [[front, -1], [rear, 1]].forEach(([grp, sgn]) => {
      for (let i = 0; i < 9; i++) {
        const phi = (i / 9) * Math.PI * 2 + rand(-0.2, 0.2), r = 1.1;
        const pg = petalGeo(rand(0.25, 0.45), rand(0.3, 0.6), rand(0.4, 1.3));
        const m = mk(pg, hullMat, 0, 0, 0, grp);
        const radial = new THREE.Vector3(Math.sin(phi) * 1.06, -Math.cos(phi), 0).normalize();
        const along = new THREE.Vector3(0, 0, sgn);
        const xA = new THREE.Vector3().crossVectors(along, radial);
        m.matrixAutoUpdate = false;
        m.matrix.makeBasis(xA, along, radial).setPosition(Math.sin(phi) * r * 1.06, -Math.cos(phi) * r * 0.85, sgn * -0.05);
      }
    });
    // orbital manoeuvring pods either side of the fin
    [-1, 1].forEach(sx => {
      const pod = lathe([[0.01, 0], [0.2, 0.05], [0.3, 0.3], [0.33, 0.8], [0.33, 1.7], [0.27, 2.05], [0.15, 2.2], [0.01, 2.24]], 24);
      pod.rotateX(Math.PI / 2);
      paint(pod, (c, x, y, z) => c.copy(lin(0xd0d2d5)).multiplyScalar(1 - 0.5 * sstep(fbm3(x * 3, y * 3, z, 3), 0.45, 0.72)).lerp(lin(0x14110e), sstep(-z, 0.0, 0.6) * 0.5));
      mk(pod, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2, normalMap: panelN2, envMap: envTex, envMapIntensity: 0.5 }), 0.62 * sx, 0.66, -4.4, rear);
      const nz = lathe([[0.08, 0], [0.1, 0.08], [0.15, 0.3]], 18); nz.rotateX(-Math.PI / 2);
      paint(nz, (c, x, y, z) => c.copy(lin(0x6e4e2e)).lerp(lin(0x3a3a5a), sstep(-z, 0.05, 0.25)));
      mk(nz, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.9, envMap: envTex, side: THREE.DoubleSide }), 0.62 * sx, 0.66, -4.42, rear);
    });
    // body flap under the engines
    { const bf = mk(rbox(1.7, 0.12, 0.7, 0.04), new THREE.MeshStandardMaterial({ color: lin(0x1d1e21), roughness: 0.85 }), 0, -0.62, -4.6, rear); bf.rotation.x = 0.12; }
    // snapped nose-gear leg and its wheel thrown into the grass
    { const leg = new THREE.Group(); leg.position.set(0.15, -0.75, 2.4); leg.rotation.set(0.9, 0, 0.35); front.add(leg);
      mk(new THREE.CylinderGeometry(0.075, 0.085, 0.9, 12), darkMetal, 0, -0.45, 0, leg);
      mk(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 10), new THREE.MeshStandardMaterial({ color: lin(0xb8bcc2), metalness: 1, roughness: 0.2, envMap: envTex }), 0, -0.95, 0, leg);
      mk(new THREE.ConeGeometry(0.06, 0.12, 6), darkMetal, 0, -1.25, 0, leg).rotation.z = 0.5; }
    W.wheel = new THREE.Group(); scene.add(W.wheel);
    { const tire = new THREE.TorusGeometry(0.3, 0.12, 14, 32);
      const tp = tire.attributes.position; for (let i = 0; i < tp.count; i++) { const x = tp.getX(i), y = tp.getY(i), a = Math.atan2(y, x); const r = Math.hypot(x, y); if (r > 0.38) { const k = 1 + Math.max(0, Math.sin(a * 24)) * 0.03; tp.setX(i, x * k); tp.setY(i, y * k); } }
      tire.computeVertexNormals();
      mk(tire, new THREE.MeshStandardMaterial({ color: lin(0x18181a), roughness: 0.9 }), 0, 0, 0, W.wheel);
      const hub = mk(new THREE.CylinderGeometry(0.2, 0.2, 0.2, 20), new THREE.MeshStandardMaterial({ color: lin(0x9aa0a8), metalness: 0.9, roughness: 0.3, envMap: envTex }), 0, 0, 0, W.wheel); hub.rotation.x = Math.PI / 2; }
    { const al = -2.5, lat = -3.9, x = CRASH.c.x + CRASH.dir.x * al + CRASH.perp.x * lat, z = CRASH.c.z + CRASH.dir.z * al + CRASH.perp.z * lat;
      W.wheel.position.set(x, heightAt(x, z) + 0.2, z); W.wheel.rotation.set(1.25, 0.6, 0.1); OBST.push({ x, z, r: 0.55, type: 'wreckage' }); }
    // dark interiors, torn ribs and stringers at the break
    mk(new THREE.CircleGeometry(0.98, 32), innerMat, 0, -0.05, 0.65, front, false);
    mk(new THREE.CircleGeometry(0.98, 32), innerMat, 0, -0.05, -0.65, rear, false);
    [[front, 1], [rear, -1]].forEach(([grp, sgn]) => {
      for (let i = 0; i < 3; i++) { const r = mk(new THREE.TorusGeometry(1.04 - i * 0.015, 0.045, 6, 36, Math.PI * 2 * rand(0.55, 0.85)), darkMetal, 0, 0, sgn * (0.22 + i * 0.32), grp); r.rotation.z = rng() * 6.28; r.scale.y = 0.92; }
      for (let i = 0; i < 7; i++) {
        const a = rng() * Math.PI * 2, L = rand(0.5, 1.1);
        const st = mk(new THREE.BoxGeometry(0.05, 0.05, L), darkMetal, Math.sin(a) * 1.0, Math.cos(a) * 0.85, sgn * (0.3 - L / 2) , grp);
        st.rotation.x = rand(-0.35, 0.35); st.rotation.y = rand(-0.3, 0.3);
      }
    });
    // interior emergency light that flickers
    W.panelLight = mk(new THREE.BoxGeometry(0.25, 0.06, 0.04), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.4, 3.8) }), 0.3, 0.55, 0.9, front, false);
    // wings
    function wingGeo() {
      const sh = new THREE.Shape();
      sh.moveTo(0, -0.3); sh.lineTo(0, 3.6); sh.lineTo(1.2, 3.0); sh.lineTo(3.4, 0.9); sh.lineTo(3.6, 0.1); sh.lineTo(3.4, -0.4); sh.lineTo(0, -0.3);
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.05, bevelSegments: 2 });
      g.rotateX(Math.PI / 2);
      paint(g, (c, x, y, z) => { c.setRGB(1, 1, 1).lerp(lin(0x2a2b2e), sstep(-y, 0.04, 0.11)); });
      return g;
    }
    { const w = mk(wingGeo(), wingMat, 0.95, -0.5, -4.05, rear); w.rotation.z = 0.3; w.rotation.y = 0.04; }
    W.navLight = mk(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 4, 0.6) }), 0, 0, 0, rear, false);
    { const tipL = new THREE.Vector3(0.95 + 3.6 * Math.cos(0.3), -0.5 + 3.6 * Math.sin(0.3), -4.05 + 0.1); W.navLight.position.copy(tipL); }
    // the other wing, torn off and lying in the grass
    W.brokenWing = new THREE.Group(); scene.add(W.brokenWing);
    { const w = mk(wingGeo(), wingMat, 0, 0, 0, W.brokenWing); w.scale.x = -1; }
    W.brokenWing.position.set(CRASH.wing.x, heightAt(CRASH.wing.x, CRASH.wing.z) + 0.05, CRASH.wing.z);
    W.brokenWing.rotation.set(0.05, 2.3, 0.22);
    // tail fin with a blinking beacon
    { const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(2.4, 0); sh.lineTo(0.8, 1.8); sh.lineTo(0.1, 1.8); sh.lineTo(0, 0);
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.04, bevelSegments: 2 });
      g.translate(0, 0, -0.07); g.rotateY(-Math.PI / 2);
      paint(g, (c, x, y, z) => c.setRGB(1, 1, 1).lerp(lin(0x2a2d32), sstep(y, 1.45, 1.8)));
      const fin = mk(g, wingMat, 0, 0.92, -4.35, rear); fin.rotation.z = 0.1; }
    W.beacon = mk(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.3, 0.2) }), 0.18, 0.92 + 1.8, -4.35 + 0.45, rear, false);
    // engine bells, heat-tinted, still smouldering
    W.engineGlow = [];
    [[0.45, -0.12], [-0.45, -0.12], [0, 0.42]].forEach(([x, y]) => {
      const g = lathe([[0.2, 0], [0.24, 0.1], [0.33, 0.4], [0.43, 0.75]], 28); g.rotateX(-Math.PI / 2);
      paint(g, (c, X, Y, Z) => { const t = -Z / 0.75; c.copy(lin(0x7a5530)).lerp(lin(0x3d3c5e), sstep(t, 0.2, 0.6)).lerp(lin(0x5a5c60), sstep(t, 0.6, 1)); });
      mk(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.9, envMap: envTex, envMapIntensity: 0.9, side: THREE.DoubleSide }), x, y, -4.45, rear);
      const gl = mk(new THREE.CircleGeometry(0.2, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.55, 0.12), side: THREE.DoubleSide }), x, y, -4.47, rear, false);
      W.engineGlow.push(gl);
    });
    // clods of ploughed soil along the gouge and piled against the nose
    { const cg = makeRock(31); const cp = cg.attributes.position;
      const cm = new THREE.MeshLambertMaterial({ vertexColors: true });
      paint(cg, (c, x, y, z) => c.copy(lin(0x2e2418)).lerp(lin(0x4a3b28), vnoise3(x * 4, y * 4, z * 4)).lerp(lin(0x2a3a18), sstep(y, 0.2, 0.5) * 0.3));
      const N = isSmall ? 90 : 190, im = new THREE.InstancedMesh(cg, cm, N);
      for (let i = 0; i < N; i++) {
        let al, lat;
        if (i < N * 0.3) { al = rand(-7.5, -4.8); lat = rand(-2.6, 2.6); } else { al = rand(-5, 15); lat = (rng() < 0.5 ? -1 : 1) * rand(1.4, 3.4); }
        const x = CRASH.c.x + CRASH.dir.x * al + CRASH.perp.x * lat, z = CRASH.c.z + CRASH.dir.z * al + CRASH.perp.z * lat;
        const sc = rand(0.05, 0.28) * (i < N * 0.3 ? 1.4 : 1);
        tmpP.set(x, heightAt(x, z) - sc * 0.25, z); tmpQ.setFromEuler(new THREE.Euler(rng() * 3, rng() * 6, rng() * 3)); tmpS.set(sc, sc * rand(0.6, 1), sc);
        tmpM.compose(tmpP, tmpQ, tmpS); im.setMatrixAt(i, tmpM);
      }
      // bounds covering every piece, so the shadow cameras (and the main camera) can skip the field when it's out of view
      { const box = new THREE.Box3(), v = new THREE.Vector3(); for (let i = 0; i < N; i++) { im.getMatrixAt(i, tmpM); box.expandByPoint(v.setFromMatrixPosition(tmpM)); }
        im.geometry.boundingSphere = box.expandByScalar(0.6).getBoundingSphere(new THREE.Sphere()); }
      im.castShadow = true; im.receiveShadow = true; scene.add(im); }
    { const N = isSmall ? 30 : 60;
      W.emberMat = new THREE.MeshBasicMaterial({ map: glowTexture(255, 120, 40), color: new THREE.Color(2.4, 0.7, 0.15), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const eg = new THREE.PlaneGeometry(1, 1); eg.rotateX(-Math.PI / 2);
      const im = new THREE.InstancedMesh(eg, W.emberMat, N);
      for (let i = 0; i < N; i++) {
        let x, z, k = 0; do { const al = rand(-6, 13), lat = rand(-2.8, 2.8); x = CRASH.c.x + CRASH.dir.x * al + CRASH.perp.x * lat; z = CRASH.c.z + CRASH.dir.z * al + CRASH.perp.z * lat; k++; } while (crashBurn(x, z) < 0.6 && k < 20);
        const sc = rand(0.15, 0.6); tmpP.set(x, heightAt(x, z) + 0.03, z); tmpQ.setFromAxisAngle(UP, rng() * 6); tmpS.set(sc, 1, sc * rand(0.5, 1));
        tmpM.compose(tmpP, tmpQ, tmpS); im.setMatrixAt(i, tmpM);
      }
      im.frustumCulled = false; im.renderOrder = 1; scene.add(im); }
    // scattered hull debris along the gouge
    for (let i = 0; i < 14; i++) {
      const along = rand(-1, 14), lat = rand(-3.5, 3.5) * (0.4 + along / 14);
      const x = CRASH.c.x + CRASH.dir.x * along + CRASH.perp.x * lat, z = CRASH.c.z + CRASH.dir.z * along + CRASH.perp.z * lat;
      const w = rand(0.2, 0.9), dpth = rand(0.2, 0.7);
      const g = new THREE.BoxGeometry(w, 0.025, dpth, 3, 1, 3);
      const P = g.attributes.position; for (let k = 0; k < P.count; k++) P.setY(k, P.getY(k) + (vnoise3(P.getX(k) * 4 + i, 0, P.getZ(k) * 4) - 0.5) * 0.12);
      g.computeVertexNormals();
      const white = rng() < 0.6; paint(g, c => c.copy(white ? lin(0xbfc2c6) : lin(0x1d1e21)).multiplyScalar(rand(0.5, 1)));
      const m = mk(g, partMat, x, heightAt(x, z) + 0.01, z, scene); m.rotation.set(rand(-0.4, 0.4), rng() * 6.28, rand(-0.4, 0.4));
    }
    W.root.updateMatrixWorld(true); W.brokenWing.updateMatrixWorld(true);
    const wpt = (grp, x, y, z) => grp.localToWorld(new THREE.Vector3(x, y, z));
    const onGround = (v) => { v.y = heightAt(v.x, v.z); return v; };
    // dangling cables from the break, down into the grass
    W.cableEnds = [];
    const cableCols = [0x151515, 0xa3262a, 0xd9b02a, 0x1d1d1d, 0xd9661f];
    for (let i = 0; i < 5; i++) {
      const a = rand(-1.6, 1.6), st = wpt(front, Math.sin(a) * 0.85, Math.cos(a) * 0.7 - 0.1, 0.05);
      const end = onGround(st.clone().add(new THREE.Vector3(rand(-0.9, 0.9), 0, rand(-0.9, 0.9))));
      end.y += 0.02;
      const mid = st.clone().lerp(end, 0.5); mid.y = Math.min(st.y, end.y) + 0.05;
      const tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([st, st.clone().lerp(mid, 0.5).add(new THREE.Vector3(0, -0.1, 0)), mid, end]), 20, 0.02, 6);
      mk(tg, new THREE.MeshStandardMaterial({ color: lin(cableCols[i]), roughness: 0.6 }), 0, 0, 0, scene);
      W.cableEnds.push(end);
    }
    // ---------- particle fire, smoke and embers (GPU, stateless) ----------
    const gl = renderer.getContext(), maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
    const pU = { uTime: veg.uTime, uScale: { value: 1 }, uMaxPt: { value: maxPt }, uWind: { value: new THREE.Vector2(1, 0.45).normalize() }, uMoon: { value: 1 } };
    W.pU = pU;
    function particles(emitters, kind) {
      let n = 0; emitters.forEach(e => n += Math.max(4, Math.round(e.n * (isSmall ? 0.5 : 1))));
      const base = new Float32Array(n * 3), seed = new Float32Array(n * 4), par = new Float32Array(n * 3);
      let k = 0;
      emitters.forEach(e => { const cnt = Math.max(4, Math.round(e.n * (isSmall ? 0.5 : 1))); for (let i = 0; i < cnt; i++, k++) {
        base.set([e.p.x, e.p.y, e.p.z], k * 3); seed.set([rng(), rng(), rng(), rng()], k * 4); par.set([e.r, e.h, e.size], k * 3); } });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
      g.setAttribute('aBase', new THREE.BufferAttribute(base, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4)); g.setAttribute('aPar', new THREE.BufferAttribute(par, 3));
      const head = `uniform float uTime, uScale, uMaxPt, uMoon; uniform vec2 uWind; attribute vec3 aBase; attribute vec4 aSeed; attribute vec3 aPar; varying float vAge; varying float vSeed;`;
      const vs = {
        flame: `${head} void main(){
          float life = 0.6 + aSeed.w*0.7; float age = fract(uTime/life + aSeed.x);
          vec3 p = aBase; float ang = aSeed.y*6.2831; float r = sqrt(aSeed.z)*aPar.x*(1.0 - age*0.65);
          p.x += cos(ang)*r; p.z += sin(ang)*r; p.y += age*aPar.y*(0.55 + aSeed.w*0.6);
          p.x += sin(uTime*3.1 + aSeed.x*20.0 + age*6.0)*0.16*age*aPar.x + uWind.x*age*age*aPar.y*0.35;
          p.z += cos(uTime*2.7 + aSeed.y*20.0 + age*5.0)*0.16*age*aPar.x + uWind.y*age*age*aPar.y*0.35;
          vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv;
          float size = aPar.z*(1.05 - age*0.6);
          gl_PointSize = min(size*uScale/-mv.z, uMaxPt); vAge = age; vSeed = aSeed.y; }`,
        smoke: `${head} void main(){
          float life = 6.0 + aSeed.w*5.0; float age = fract(uTime/life + aSeed.x);
          vec3 p = aBase; float ang = aSeed.y*6.2831; float r = sqrt(aSeed.z)*aPar.x*(1.0 + age*1.6);
          p.x += cos(ang)*r; p.z += sin(ang)*r; p.y += age*aPar.y + 0.4;
          p.x += uWind.x*age*age*aPar.y*0.55 + sin(uTime*0.5 + aSeed.x*30.0 + age*3.0)*0.45*age;
          p.z += uWind.y*age*age*aPar.y*0.55 + cos(uTime*0.4 + aSeed.y*30.0 + age*3.0)*0.45*age;
          vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv;
          gl_PointSize = min(aPar.z*(0.35 + age*1.9)*uScale/-mv.z, uMaxPt); vAge = age; vSeed = aSeed.y; }`,
        ember: `${head} void main(){
          float life = 1.6 + aSeed.w*1.8; float age = fract(uTime/life + aSeed.x);
          vec3 p = aBase; float ang = aSeed.y*6.2831; float r = sqrt(aSeed.z)*aPar.x;
          p.x += cos(ang)*r + sin(uTime*4.0 + aSeed.x*40.0)*0.35*age + uWind.x*age*1.6;
          p.z += sin(ang)*r + cos(uTime*3.3 + aSeed.y*40.0)*0.35*age + uWind.y*age*1.6;
          p.y += age*aPar.y*(0.5 + aSeed.z) + 0.2;
          vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv;
          gl_PointSize = clamp(aPar.z*uScale/-mv.z, 1.5, 6.0); vAge = age; vSeed = aSeed.y; }`
      };
      const fs = {
        flame: `varying float vAge; varying float vSeed; uniform float uTime;
          float hn(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
          float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hn(i), hn(i+vec2(1,0)), f.x), mix(hn(i+vec2(0,1)), hn(i+vec2(1,1)), f.x), f.y); }
          void main(){
          vec2 c = gl_PointCoord - 0.5; c.y = -c.y;
          float d = length(c*vec2(1.25, 0.8))*2.0;
          float n = n2(c*4.0 + vec2(vSeed*31.0, -uTime*3.0 - vSeed*7.0))*0.6 + n2(c*9.0 + vec2(vSeed*13.0, -uTime*5.0))*0.4;
          float a = smoothstep(1.0, 0.2, d + (n - 0.5)*1.1 - c.y*0.35); a *= a;
          vec3 col = mix(vec3(6.0,4.4,2.2), vec3(4.0,1.5,0.32), smoothstep(0.0, 0.35, vAge));
          col = mix(col, vec3(1.0,0.2,0.04), smoothstep(0.35, 0.85, vAge));
          float fade = smoothstep(0.0, 0.08, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
          gl_FragColor = vec4(col*a*fade*0.27, 1.0); }`,
        smoke: `uniform float uMoon; varying float vAge; varying float vSeed; void main(){
          vec2 c = gl_PointCoord - 0.5; float d = length(c)*2.0;
          vec2 q = c*3.0 + vec2(vSeed*17.0, vAge*2.0);
          float n = fract(sin(dot(floor(q), vec2(127.1,311.7)))*43758.5); vec2 fq = fract(q); fq = fq*fq*(3.0-2.0*fq);
          float n00 = fract(sin(dot(floor(q), vec2(127.1,311.7)))*43758.5), n10 = fract(sin(dot(floor(q)+vec2(1,0), vec2(127.1,311.7)))*43758.5);
          float n01 = fract(sin(dot(floor(q)+vec2(0,1), vec2(127.1,311.7)))*43758.5), n11 = fract(sin(dot(floor(q)+vec2(1,1), vec2(127.1,311.7)))*43758.5);
          float vn2 = mix(mix(n00, n10, fq.x), mix(n01, n11, fq.x), fq.y);
          float a = smoothstep(1.0, 0.1, d + (vn2 - 0.5)*0.9);
          float fade = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.5, 1.0, vAge));
          vec3 col = mix(vec3(0.9,0.33,0.07)*1.6, vec3(0.045,0.043,0.045), smoothstep(0.0, 0.22, vAge));
          col += vec3(0.05,0.06,0.09)*smoothstep(0.25, 1.0, vAge)*uMoon;
          gl_FragColor = vec4(col, a*fade*0.55); }`,
        ember: `varying float vAge; varying float vSeed; uniform float uTime; void main(){
          vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(c));
          float tw = step(0.0, sin(uTime*18.0 + vSeed*60.0)) * 0.6 + 0.4;
          gl_FragColor = vec4(vec3(7.0,2.6,0.5)*a*(1.0 - vAge)*tw, 1.0); }`
      };
      const additive = kind !== 'smoke';
      const m = new THREE.ShaderMaterial({ uniforms: pU, vertexShader: vs[kind], fragmentShader: fs[kind], transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
      const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = additive ? 3 : 2; scene.add(pts); return pts;
    }
    const gapP = wpt(front, 0, -0.25, 0.1).lerp(wpt(rear, 0, -0.25, -0.1), 0.5);
    const innerP = wpt(front, 0, -0.45, 0.9);
    const noseP = wpt(front, 0, -0.15, 4.1);
    const wingP = W.brokenWing.localToWorld(new THREE.Vector3(-1.2, 0.05, 1.4));
    const engP = wpt(rear, 0, 0.1, -4.75);
    const trail = [3.5, 7, 10.5].map((al, i) => { const lat = [0.6, -0.5, 0.25][i]; const x = CRASH.c.x + CRASH.dir.x * al + CRASH.perp.x * lat, z = CRASH.c.z + CRASH.dir.z * al + CRASH.perp.z * lat; OBST.push({ x, z, r: 1.0, type: 'fire' }); return new THREE.Vector3(x, heightAt(x, z), z); });
    particles([{ p: gapP, r: 0.7, h: 2.5, size: 0.9, n: 230 }, { p: innerP, r: 0.45, h: 1.5, size: 0.6, n: 90 }, { p: noseP, r: 0.6, h: 1.9, size: 0.75, n: 140 },
               { p: wingP, r: 0.5, h: 1.2, size: 0.55, n: 70 }, ...trail.map(p => ({ p, r: 0.35, h: 0.8, size: 0.42, n: 36 }))], 'flame');
    particles([{ p: gapP, r: 0.6, h: 17, size: 2.4, n: 120 }, { p: noseP, r: 0.5, h: 12, size: 1.9, n: 75 }, { p: wingP, r: 0.4, h: 7, size: 1.3, n: 40 }, { p: engP, r: 0.3, h: 6, size: 1.0, n: 32 },
               ...trail.map(p => ({ p, r: 0.3, h: 4, size: 0.8, n: 14 }))], 'smoke');
    particles([{ p: gapP, r: 0.8, h: 6, size: 0.05, n: 90 }, { p: noseP, r: 0.6, h: 4.5, size: 0.045, n: 50 }, { p: wingP, r: 0.4, h: 3, size: 0.04, n: 25 }], 'ember');

    // ---------- its approach: a pine snapped off and smouldering, another felled into the meadow ----------
    {
      const barkC = lin(0x3a2c22), barkC2 = lin(0x6a5848), woodC = lin(0xcaa772), charC = lin(0x0d0b0a), charC2 = lin(0x2a2420);
      const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, normalMap: furN, normalScale: new THREE.Vector2(0.4, 0.4) });
      // a trunk section whose top end is torn off jaggedly; the end face shows raw (or burnt) wood
      function brokenTrunk(rB, rT, len, jag, burnt, seed) {
        const g = new THREE.CylinderGeometry(rT, rB, len, 14, 8); g.translate(0, len / 2, 0);
        paint(g, (c, x, y, z, i) => {
          const a = Math.atan2(z, x), n = vnoise3(Math.cos(a) * 5, y * 6, seed);
          if (g.attributes.normal.getY(i) > 0.5) c.copy(burnt ? charC2 : woodC).multiplyScalar(0.8 + 0.4 * n);
          else { c.copy(barkC).lerp(barkC2, n * 0.7); if (burnt) c.lerp(charC, Math.min(1, Math.max(0, 0.55 + 0.6 * y / len + (n - 0.5)))); }
        });
        const pp = g.attributes.position;
        for (let i = 0; i < pp.count; i++) {
          const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
          if (y > len - 1e-3) { const a = Math.atan2(z, x), r = Math.hypot(x, z);
            pp.setY(i, y - jag * (r < 1e-3 ? 0.5 : vnoise3(Math.cos(a) * 2.5, Math.sin(a) * 2.5, seed + 9))); }
        }
        g.computeVertexNormals(); return g;
      }
      // long splinters standing up round the rim of a break
      function splinters(n, R, y0, len, col) {
        const parts = [];
        for (let k = 0; k < n; k++) {
          const a = k / n * Math.PI * 2 + rand(-0.3, 0.3), L = len * rand(0.4, 1.1);
          const sg = new THREE.ConeGeometry(rand(0.025, 0.06), L, 4); sg.translate(0, L / 2, 0);
          const sh = rand(0.75, 1.15); paint(sg, c => c.copy(col).multiplyScalar(sh));
          sg.rotateZ(-rand(0.05, 0.4)); sg.rotateY(-a);
          sg.translate(Math.cos(a) * R * 0.75, y0 - rand(0, len * 0.4), Math.sin(a) * R * 0.75);
          parts.push(sg);
        }
        return mergeGeos(parts);
      }
      const flare = (rTop, rBot, h) => { const g = new THREE.CylinderGeometry(rTop, rBot, h, 14); g.translate(0, h / 2, 0); paint(g, (c, x, y, z) => c.copy(barkC).lerp(barkC2, vnoise3(x * 6, y * 6, z * 6) * 0.6)); return g; };
      // lay a mesh down so its local +y runs from `from` along the ground in direction dirH; local z ends up vertical
      const basis = new THREE.Matrix4();
      function layDown(obj, from, dirH, len, lift) {
        const to = from.clone().addScaledVector(dirH, len);
        from.y = heightAt(from.x, from.z) + lift; to.y = heightAt(to.x, to.z) + lift;
        const yA = to.sub(from).normalize(), zA = new THREE.Vector3(0, 1, 0).addScaledVector(yA, -yA.y).normalize(), xA = new THREE.Vector3().crossVectors(yA, zA);
        obj.quaternion.setFromRotationMatrix(basis.makeBasis(xA, yA, zA)); obj.position.copy(from);
      }
      const back = new THREE.Vector3(-CRASH.dir.x, 0, -CRASH.dir.z);   // the way the craft was travelling

      // --- the snag: snapped at ~7 m, charred, leaning the way the craft went, still smouldering at the break
      const SH = 7.2, snag = new THREE.Group();
      snag.position.set(CRASH.snag.x, heightAt(CRASH.snag.x, CRASH.snag.z) - 0.2, CRASH.snag.z);
      snag.quaternion.setFromUnitVectors(UP, new THREE.Vector3(0, 1, 0).addScaledVector(back, 0.09).normalize());
      scene.add(snag);
      mk(brokenTrunk(0.42, 0.3, SH, 1.1, true, 3), woodMat, 0, 0, 0, snag);
      mk(splinters(9, 0.3, SH - 0.45, 0.9, charC2), woodMat, 0, 0, 0, snag);
      mk(flare(0.42, 0.78, 0.55), woodMat, 0, 0, 0, snag);
      for (let k = 0; k < 7; k++) {   // bare, burnt branch stubs
        const s = new THREE.Group(); s.position.y = rand(2.4, SH - 1.4); s.rotation.y = rng() * Math.PI * 2; snag.add(s);
        mk(brokenTrunk(0.06, 0.035, rand(0.4, 1.3), 0.12, true, 10 + k), woodMat, 0, 0, 0, s).rotation.z = -rand(1.0, 1.4);
      }
      const coalMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.7, 0.15) });
      for (let k = 0; k < 10; k++) {   // coals glowing in the broken top
        const a = rng() * Math.PI * 2, r = rand(0.05, 0.28);
        mk(new THREE.SphereGeometry(rand(0.03, 0.07), 6, 5), coalMat, Math.cos(a) * r, SH - rand(0.35, 0.9), Math.sin(a) * r, snag, false).scale.y = 0.5;
      }
      mergeRig(snag);
      snag.updateMatrixWorld(true);
      const snagTop = snag.localToWorld(new THREE.Vector3(0, SH - 0.5, 0));
      OBST.push({ x: CRASH.snag.x, z: CRASH.snag.z, r: 0.8, type: 'tree' });
      // its top, thrown down beside it; the torn end points back at the snag
      const topPiece = new THREE.Group(); scene.add(topPiece);
      const tDir = back.clone().applyAxisAngle(UP, 0.6).negate();
      const tFrom = new THREE.Vector3(CRASH.snag.x, 0, CRASH.snag.z).addScaledVector(tDir, -6.8);
      layDown(topPiece, tFrom, tDir, 5.6, 0.2);
      mk(brokenTrunk(0.1, 0.28, 5.6, 0.7, true, 21), woodMat, 0, 0, 0, topPiece);
      mk(splinters(7, 0.28, 5.4, 0.7, charC2), woodMat, 0, 0, 0, topPiece);
      topPiece.updateMatrixWorld(true);
      const pieceEnd = topPiece.localToWorld(new THREE.Vector3(0, 5.3, 0));
      for (let k = 0; k < 6; k++) OBST.push({ x: tFrom.x + tDir.x * k, z: tFrom.z + tDir.z * k, r: 0.45, type: 'tree' });

      particles([{ p: snagTop, r: 0.22, h: 10, size: 1.5, n: 55 }, { p: pieceEnd, r: 0.2, h: 4, size: 0.8, n: 14 }], 'smoke');
      particles([{ p: snagTop.clone().add(new THREE.Vector3(0, -0.35, 0)), r: 0.2, h: 0.45, size: 0.32, n: 30 }], 'flame');
      particles([{ p: snagTop, r: 0.3, h: 3.5, size: 0.04, n: 22 }], 'ember');
      W.snagLight = new THREE.PointLight(lin(0xff6a20), 1.2, 8, 2); W.snagLight.position.copy(snagTop).add(new THREE.Vector3(0, 0.3, 0)); scene.add(W.snagLight);
      W.coalMat = coalMat;

      // --- the felled pine: a splintered stump, and the tree lying in the grass where it came down
      const stump = new THREE.Group(); stump.position.set(CRASH.stump.x, heightAt(CRASH.stump.x, CRASH.stump.z) - 0.1, CRASH.stump.z); scene.add(stump);
      mk(brokenTrunk(0.34, 0.29, 0.9, 0.45, false, 7), woodMat, 0, 0, 0, stump);
      mk(splinters(8, 0.29, 0.8, 0.65, woodC), woodMat, 0, 0, 0, stump);
      mk(flare(0.34, 0.62, 0.4), woodMat, 0, 0, 0, stump);
      OBST.push({ x: CRASH.stump.x, z: CRASH.stump.z, r: 0.55, type: 'tree' });
      const FH = CRASH.fall.len, FW = FH * 0.95;
      const fDir = new THREE.Vector3(CRASH.fall.dx, 0, CRASH.fall.dz), fFrom = new THREE.Vector3(CRASH.fall.x, 0, CRASH.fall.z);
      const fallen = new THREE.Mesh(makePine({ seed: 7, whorls: Math.round(24 * (isSmall ? 0.7 : 1)), bMin: 5, bMax: 7, spread: 0.19, shape: 0.85, droop: 0.32, thick: 0.34, crown: 0.34, top: 0.97, topR: 0.005, baseR: 0.021, flare: 0 }),
        new THREE.MeshLambertMaterial({ vertexColors: true }));
      layDown(fallen, fFrom.clone(), fDir, FH, 0.55);   // the butt rests at stump height, the rest propped on its branches
      fallen.scale.set(FW, FH, FW * 0.45);   // branches squashed flat against the ground, still spread sideways
      fallen.castShadow = true; fallen.receiveShadow = true; scene.add(fallen);
      { const butt = new THREE.Group(); butt.position.copy(fallen.position); butt.quaternion.copy(fallen.quaternion); scene.add(butt);
        const sg = splinters(7, 0.26, 0, 0.5, woodC); sg.rotateX(Math.PI); mk(sg, woodMat, 0, 0, 0, butt);
        const face = new THREE.CircleGeometry(0.26, 14); face.rotateX(Math.PI / 2); paint(face, c => c.copy(woodC).multiplyScalar(rand(0.85, 1.05))); mk(face, woodMat, 0, 0, 0, butt); }
      // the birds like a fallen log and a stump as much as a rock
      fallen.updateMatrixWorld(true);
      PERCHES.push({ p: stump.position.clone().add(new THREE.Vector3(0, 0.68, 0)), taken: null });
      for (const d of [1.6, 3.4]) { const q = fallen.localToWorld(new THREE.Vector3(0, d / FH, 0)); q.y += 0.021 * FW * (1 - 0.75 * d / FH); PERCHES.push({ p: q, taken: null }); }
      for (let d = 0.8; d < FH * 0.92; d += 0.9) {
        const tt = d / FH, half = Math.max(0.5, 0.19 * FW * Math.pow(Math.max(0, 1 - tt), 0.85) * (tt > 0.3 ? 0.85 : 0));
        OBST.push({ x: fFrom.x + fDir.x * d, z: fFrom.z + fDir.z * d, r: half, type: 'tree' });
      }
    }
    // firelight
    W.fire1 = new THREE.PointLight(lin(0xff7a2a), 5, 26, 2); W.fire1.position.copy(gapP).add(new THREE.Vector3(0, 1.1, 0));
    if (!isSmall) { W.fire1.castShadow = true; W.fire1.shadow.mapSize.set(512, 512); W.fire1.shadow.bias = -0.006; W.fire1.shadow.camera.near = 0.3; W.fire1.shadow.camera.far = 26; }
    W.fire2 = new THREE.PointLight(lin(0xff8a3a), 3, 16, 2); W.fire2.position.copy(noseP).add(new THREE.Vector3(0, 0.9, 0));
    W.elec = new THREE.PointLight(lin(0xa8cfff), 0, 16, 2);
    scene.add(W.fire1, W.fire2, W.elec);
    // ---------- electrical arcs ----------
    const arcMat = new THREE.LineBasicMaterial({ color: new THREE.Color(6, 8, 16), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const arcMat2 = new THREE.LineBasicMaterial({ color: new THREE.Color(1.8, 2.6, 6.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const glowTex = glowTexture(170, 210, 255);
    function makeArc(a, b) {
      const segs = 16, lines = [];
      for (let k = 0; k < 4; k++) {
        const n = k === 3 ? 7 : segs + 1;
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        const l = new THREE.Line(g, k === 0 ? arcMat : arcMat2); l.frustumCulled = false; l.visible = false; l.renderOrder = 4; scene.add(l); lines.push(l);
      }
      const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(3, 4, 7), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      flare.visible = false; flare.scale.setScalar(0.5); scene.add(flare);
      return { a, b, lines, flare, segs, on: false, timer: rand(0.3, 2), regen: 0 };
    }
    const tmpU = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpAB = new THREE.Vector3();
    function regenArc(A) {
      tmpAB.copy(A.b).sub(A.a); const len = tmpAB.length();
      tmpU.crossVectors(tmpAB, UP); if (tmpU.lengthSq() < 1e-4) tmpU.set(1, 0, 0); tmpU.normalize(); tmpV.crossVectors(tmpAB, tmpU).normalize();
      let hit = null;
      A.lines.forEach((l, k) => {
        const arr = l.geometry.attributes.position.array, n = arr.length / 3;
        if (k < 3) {
          let o1 = 0, o2 = 0;
          for (let i = 0; i < n; i++) {
            const tt = i / (n - 1), env = Math.sin(Math.PI * tt);
            o1 += (rng() - 0.5) * len * 0.22; o2 += (rng() - 0.5) * len * 0.22; o1 *= 0.8; o2 *= 0.8;
            const jx = k ? (rng() - 0.5) * 0.03 : 0;
            arr[i * 3] = A.a.x + tmpAB.x * tt + (tmpU.x * o1 + tmpV.x * o2) * env + jx;
            arr[i * 3 + 1] = A.a.y + tmpAB.y * tt + (tmpU.y * o1 + tmpV.y * o2) * env + jx;
            arr[i * 3 + 2] = A.a.z + tmpAB.z * tt + (tmpU.z * o1 + tmpV.z * o2) * env;
          }
          if (k === 0) { const m = Math.floor(rand(3, n - 3)); hit = new THREE.Vector3(arr[m * 3], arr[m * 3 + 1], arr[m * 3 + 2]); }
        } else {
          const sx = hit.x, sy = hit.y, sz = hit.z; const dx = rand(-1, 1), dy = rand(-0.8, 0.4), dz = rand(-1, 1), bl = len * rand(0.25, 0.45);
          for (let i = 0; i < n; i++) { const tt = i / (n - 1); arr[i * 3] = sx + dx * bl * tt + (rng() - 0.5) * 0.06; arr[i * 3 + 1] = sy + dy * bl * tt + (rng() - 0.5) * 0.06; arr[i * 3 + 2] = sz + dz * bl * tt + (rng() - 0.5) * 0.06; }
        }
        l.geometry.attributes.position.needsUpdate = true;
      });
      return hit;
    }
    const bwRoot = W.brokenWing.localToWorld(new THREE.Vector3(0, 0.02, 1.6));
    W.arcs = [
      makeArc(wpt(front, 0.55, 0.55, 0.06), wpt(rear, 0.35, 0.6, -0.06)),
      makeArc(wpt(front, -0.6, -0.35, 0.05), W.cableEnds[0]),
      makeArc(W.cableEnds[2], W.cableEnds[3]),
      makeArc(wpt(rear, 0.45, 0.55, -4.25), wpt(rear, -0.25, 0.8, -4.38)),
      makeArc(bwRoot, onGround(bwRoot.clone().add(new THREE.Vector3(0.7, 0, -0.5))))
    ];
    // ---------- spark showers (CPU, with gravity and bounce) ----------
    const SN = 280, spP = new Float32Array(SN * 3), spC = new Float32Array(SN * 3), spV = new Float32Array(SN * 3), spL = new Float32Array(SN), spM = new Float32Array(SN);
    for (let i = 0; i < SN; i++) spP[i * 3 + 1] = -999;
    const spG = new THREE.BufferGeometry(); spG.setAttribute('position', new THREE.BufferAttribute(spP, 3)); spG.setAttribute('color', new THREE.BufferAttribute(spC, 3));
    const spPts = new THREE.Points(spG, new THREE.PointsMaterial({ size: 0.07, map: glowTexture(255, 235, 180), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    spPts.frustumCulled = false; spPts.renderOrder = 5; scene.add(spPts);
    let spCursor = 0;
    function sparks(p, n) {
      for (let j = 0; j < n; j++) {
        const i = spCursor = (spCursor + 1) % SN;
        spP[i * 3] = p.x; spP[i * 3 + 1] = p.y; spP[i * 3 + 2] = p.z;
        const a = rng() * Math.PI * 2, sp = rand(1.2, 4.5), up = rand(0.2, 1);
        spV[i * 3] = Math.cos(a) * sp * (1 - up * 0.5); spV[i * 3 + 1] = up * sp; spV[i * 3 + 2] = Math.sin(a) * sp * (1 - up * 0.5);
        spL[i] = spM[i] = rand(0.35, 1.1);
      }
    }
    mergeRig(W.root, { keep: [W.panelLight, W.navLight, W.beacon, ...W.engineGlow] });
    W.status = 'Burning';
    W.update = (dt, t) => {
      pU.uMoon.value = state.moonGain;
      const fl1 = 0.75 + Math.sin(t * 9.3) * 0.12 + Math.sin(t * 23.1) * 0.08 + Math.random() * 0.12;
      const fl2 = 0.75 + Math.sin(t * 11.7 + 1) * 0.12 + Math.sin(t * 19.3) * 0.08 + Math.random() * 0.12;
      W.fire1.intensity = 4.2 * fl1; W.fire2.intensity = 2.8 * fl2;
      const smoulder = 0.7 + 0.3 * Math.sin(t * 1.9) * Math.sin(t * 3.7) + Math.random() * 0.12;
      W.snagLight.intensity = 1.3 * smoulder; W.coalMat.color.setRGB(2.4, 0.7, 0.15).multiplyScalar(0.55 + 0.6 * smoulder);
      heatU.value = 0.65 + 0.35 * Math.sin(t * 1.3) + Math.random() * 0.1;
      W.emberMat.color.setRGB(2.4, 0.7, 0.15).multiplyScalar(0.6 + 0.4 * Math.sin(t * 1.7) * Math.sin(t * 2.9) + Math.random() * 0.15);
      W.engineGlow.forEach((g, i) => g.material.color.setRGB(2.2, 0.55, 0.12).multiplyScalar(0.55 + 0.45 * Math.sin(t * 0.8 + i)));
      W.beacon.visible = (t % 1.4) < 0.18;
      W.navLight.visible = Math.sin(t * 7.3) + Math.sin(t * 17.1) > 0.4;
      W.panelLight.visible = Math.random() > (Math.sin(t * 0.7) > 0.3 ? 0.08 : 0.6);
      let flash = 0, flashPos = null;
      W.arcs.forEach(A => {
        A.timer -= dt;
        if (A.on) {
          A.regen -= dt;
          if (A.regen <= 0) { const hit = regenArc(A); A.regen = rand(0.03, 0.07); if (rng() < 0.35) sparks(hit, 4); A.flare.position.copy(hit); }
          flash = Math.max(flash, rand(0.5, 1)); flashPos = A.flare.position;
          A.flare.scale.setScalar(rand(0.35, 0.8));
          if (A.timer <= 0) { A.on = false; A.lines.forEach(l => l.visible = false); A.flare.visible = false; A.timer = rand(0.3, 2.4); }
        } else if (A.timer <= 0) {
          A.on = true; A.timer = rand(0.06, 0.4); A.regen = 0;
          A.lines.forEach((l, k) => l.visible = k < 3 || rng() < 0.6); A.flare.visible = true;
          const hit = regenArc(A); sparks(hit, Math.round(rand(10, 26))); A.flare.position.copy(hit);
        }
      });
      W.elec.intensity = flash * rand(3, 6);
      if (flashPos) W.elec.position.copy(flashPos);
      for (let i = 0; i < SN; i++) {
        if (spL[i] <= 0) { if (spC[i * 3] !== 0) { spC[i * 3] = spC[i * 3 + 1] = spC[i * 3 + 2] = 0; spP[i * 3 + 1] = -999; } continue; }
        spL[i] -= dt; spV[i * 3 + 1] -= 9.8 * dt;
        spP[i * 3] += spV[i * 3] * dt; spP[i * 3 + 1] += spV[i * 3 + 1] * dt; spP[i * 3 + 2] += spV[i * 3 + 2] * dt;
        const gy = heightAt(spP[i * 3], spP[i * 3 + 2]) + 0.01;
        if (spP[i * 3 + 1] < gy) { spP[i * 3 + 1] = gy; spV[i * 3 + 1] *= -0.3; spV[i * 3] *= 0.5; spV[i * 3 + 2] *= 0.5; }
        const k = Math.max(0, spL[i] / spM[i]);
        spC[i * 3] = 5 * k + 0.6; spC[i * 3 + 1] = 4 * k * k + 0.2; spC[i * 3 + 2] = 2.6 * k * k * k;
      }
      spG.attributes.position.needsUpdate = true; spG.attributes.color.needsUpdate = true;
    };
    W.resize = () => { pU.uScale.value = stage.clientHeight * PR / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))); };
    W.resize();
    return W;
  })();

  await step('Calling the wildlife', 0.76);
  // ======================================================================
  // WILDLIFE: a stag and a doe that graze, wander, look up and bolt; two red squirrels that forage and climb
  // ======================================================================
  const wild = { deer: [], squirrels: [] };
  function makeDeer(stag) {
    const coat = lin(stag ? 0x6e4a2b : 0x8c613b), belly = lin(0xe0d0b4), dorsal = lin(0x4a3220), rumpW = lin(0xf0e8da);
    const coatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, normalMap: furN, normalScale: new THREE.Vector2(0.6, 0.6) });
    const solid = (hex) => new THREE.MeshStandardMaterial({ color: lin(hex), roughness: 0.92, normalMap: furN, normalScale: new THREE.Vector2(0.5, 0.5) });
    const legMat = solid(stag ? 0x5d3d22 : 0x77512f), lowLeg = solid(stag ? 0x4a321f : 0x5f4129), cream = solid(0xe6dcc6);
    const hoofMat = new THREE.MeshStandardMaterial({ color: lin(0x17120e), roughness: 0.55 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: lin(0x0d0806), roughness: 0.05, envMap: envTex, envMapIntensity: 1.2, emissive: new THREE.Color(0, 0, 0) });
    const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
    // torso
    const tg = lathe([[0, -0.63], [0.1, -0.61], [0.17, -0.53], [0.2, -0.38], [0.195, -0.2], [0.185, 0], [0.2, 0.2], [0.215, 0.36], [0.2, 0.5], [0.14, 0.6], [0, 0.635]], 32);
    tg.rotateX(Math.PI / 2);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      let x = tp.getX(i), y = tp.getY(i), z = tp.getZ(i);
      if (y < 0) { y *= 1 + 0.25 * sstep(z, 0, 0.45); if (z > -0.4 && z < 0.12) y *= 0.9; }
      tp.setXYZ(i, x * 0.8, y * 1.1, z);
    }
    tg.computeVertexNormals();
    paint(tg, (c, x, y, z) => {
      c.copy(coat).lerp(belly, sstep(-y, 0.1, 0.19)).lerp(dorsal, sstep(y, 0.15, 0.22) * 0.5);
      if (z < -0.45) c.lerp(rumpW, sstep(-z, 0.5, 0.6) * (1 - sstep(y, 0.1, 0.18)));
      c.multiplyScalar(0.9 + 0.2 * vnoise3(x * 15, y * 15, z * 15));
    });
    mk(tg, coatMat, 0, 1.0, 0, body);
    // neck
    const neck = new THREE.Group(); neck.position.set(0, 1.08, 0.5); neck.rotation.x = 0.75; body.add(neck);
    const ng = new THREE.CylinderGeometry(0.058, 0.098, 0.6, 16, 4); ng.translate(0, 0.3, 0);
    paint(ng, (c, x, y, z) => c.copy(coat).lerp(belly, sstep(z, 0.02, 0.09) * (1 - sstep(y, 0.45, 0.6)) * 0.85).lerp(lin(0xf2ece0), sstep(z, 0.03, 0.07) * sstep(y, 0.42, 0.52)));
    mk(ng, coatMat, 0, 0, 0, neck);
    if (stag) { const ruff = mk(new THREE.SphereGeometry(0.12, 14, 10), solid(0x4e3522), 0, 0.12, 0.03, neck); ruff.scale.set(0.82, 1.25, 0.82); }
    const head = new THREE.Group(); head.position.y = 0.57; head.rotation.x = -0.95; neck.add(head);
    { const sk = mk(new THREE.SphereGeometry(0.085, 20, 14), solid(stag ? 0x6a4629 : 0x86603a), 0, 0.02, 0, head); sk.scale.set(0.85, 0.9, 1.2); }
    { const mz = mk(new THREE.CylinderGeometry(0.035, 0.064, 0.21, 16), solid(stag ? 0x5f3f25 : 0x7b5634), 0, -0.02, 0.15, head); mz.rotation.x = Math.PI / 2; }
    mk(new THREE.SphereGeometry(0.034, 12, 10), cream, 0, -0.045, 0.2, head).scale.set(0.9, 0.6, 1.1);
    mk(new THREE.SphereGeometry(0.03, 14, 10), new THREE.MeshStandardMaterial({ color: lin(0x120d0b), roughness: 0.25, envMap: envTex, envMapIntensity: 0.8 }), 0, -0.018, 0.25, head).scale.set(1, 0.8, 0.8);
    for (const s of [-1, 1]) {
      mk(new THREE.SphereGeometry(0.0155, 12, 10), eyeMat, 0.062 * s, 0.04, 0.05, head, false);
      mk(new THREE.SphereGeometry(0.02, 8, 6), cream, 0.058 * s, 0.045, 0.045, head, false).scale.set(0.5, 1, 1.2);
    }
    const ears = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Group(); e.position.set(0.055 * s, 0.075, -0.035); e.rotation.z = -1.0 * s; head.add(e);
      mk(new THREE.SphereGeometry(0.075, 14, 10), solid(stag ? 0x6a4629 : 0x86603a), 0, 0.075, 0, e).scale.set(0.38, 1, 0.55);
      mk(new THREE.SphereGeometry(0.06, 12, 8), cream, 0, 0.075, 0.018, e).scale.set(0.3, 0.9, 0.3);
      ears.push(e);
    }
    if (stag) {
      const bone = new THREE.MeshStandardMaterial({ color: lin(0xc9b494), roughness: 0.7 });
      const tube = (pts, r) => mk(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(q => new THREE.Vector3(...q))), 16, r, 7), bone, 0, 0, 0, head);
      for (const s of [-1, 1]) {
        tube([[0.035 * s, 0.09, -0.02], [0.11 * s, 0.22, -0.09], [0.19 * s, 0.36, -0.06], [0.23 * s, 0.48, 0.03], [0.2 * s, 0.57, 0.13]], 0.013);
        tube([[0.05 * s, 0.13, -0.035], [0.07 * s, 0.17, 0.04], [0.08 * s, 0.2, 0.1]], 0.009);
        tube([[0.12 * s, 0.24, -0.09], [0.14 * s, 0.33, -0.02], [0.15 * s, 0.4, 0.05]], 0.009);
        tube([[0.2 * s, 0.38, -0.06], [0.24 * s, 0.48, -0.1], [0.26 * s, 0.56, -0.08]], 0.008);
        mk(new THREE.SphereGeometry(0.02, 8, 6), bone, 0.035 * s, 0.09, -0.02, head);
      }
    }
    // legs
    function leg(x, y, z, front) {
      const top = new THREE.Group(); top.position.set(x, y, z); body.add(top); const L = { top };
      if (front) {
        mk(new THREE.SphereGeometry(0.085, 14, 10), legMat, 0, -0.06, 0, top).scale.set(0.75, 1.6, 1);
        mk(new THREE.CylinderGeometry(0.05, 0.034, 0.45, 12), legMat, 0, -0.225, 0, top);
        L.mid = new THREE.Group(); L.mid.position.y = -0.45; top.add(L.mid);
        mk(new THREE.SphereGeometry(0.034, 10, 8), lowLeg, 0, 0, 0, L.mid);
        mk(new THREE.CylinderGeometry(0.026, 0.022, 0.42, 10), lowLeg, 0, -0.21, 0, L.mid);
        L.foot = new THREE.Group(); L.foot.position.y = -0.42; L.mid.add(L.foot);
      } else {
        mk(new THREE.SphereGeometry(0.11, 14, 10), legMat, 0, -0.1, 0.01, top).scale.set(0.72, 1.6, 1.15);
        mk(new THREE.CylinderGeometry(0.06, 0.045, 0.35, 12), legMat, 0, -0.175, 0, top);
        L.mid = new THREE.Group(); L.mid.position.y = -0.35; top.add(L.mid);
        mk(new THREE.CylinderGeometry(0.042, 0.03, 0.36, 10), legMat, 0, -0.18, 0, L.mid);
        L.hock = new THREE.Group(); L.hock.position.y = -0.36; L.mid.add(L.hock);
        mk(new THREE.SphereGeometry(0.032, 10, 8), lowLeg, 0, 0, -0.005, L.hock);
        mk(new THREE.CylinderGeometry(0.026, 0.022, 0.3, 10), lowLeg, 0, -0.15, 0, L.hock);
        L.foot = new THREE.Group(); L.foot.position.y = -0.3; L.hock.add(L.foot);
      }
      mk(new THREE.CylinderGeometry(0.02, 0.03, 0.06, 10), hoofMat, 0, -0.03, 0.006, L.foot);
      return L;
    }
    const fl = leg(0.105, 0.96, 0.42, true), fr = leg(-0.105, 0.96, 0.42, true);
    const hl = leg(0.105, 1.0, -0.45, false), hr = leg(-0.105, 1.0, -0.45, false);
    const tail = new THREE.Group(); tail.position.set(0, 1.07, -0.6); body.add(tail);
    mk(new THREE.SphereGeometry(0.05, 12, 8), solid(stag ? 0x5d3d22 : 0x7a5332), 0, -0.07, -0.012, tail).scale.set(0.7, 1.5, 0.4);
    mk(new THREE.SphereGeometry(0.048, 12, 8), new THREE.MeshStandardMaterial({ color: lin(0xf6f1e8), roughness: 0.95 }), 0, -0.07, 0.008, tail).scale.set(0.8, 1.45, 0.4);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.scale.setScalar(stag ? 1.0 : 0.88);
    mergeRig(g, { bones: rigParts(body, neck, head, ears, tail, fl, fr, hl, hr) }); scene.add(g);
    return { g, body, neck, head, ears, tail, fl, fr, hl, hr, eyeMat };
  }
  function deerLeg(L, p, front, amp, run) {
    if (front) {
      L.top.rotation.x = Math.sin(p) * (0.4 + 0.25 * run) * amp;
      L.mid.rotation.x = Math.max(0, Math.sin(p + 1.4)) * (0.9 + 0.7 * run) * amp;
      L.foot.rotation.x = -L.mid.rotation.x * 0.5;
    } else {
      L.top.rotation.x = 0.3 + Math.sin(p) * (0.38 + 0.25 * run) * amp;
      L.mid.rotation.x = -0.8 - Math.max(0, Math.sin(p + 1.6)) * (0.35 + 0.3 * run) * amp;
      L.hock.rotation.x = 0.5 + Math.max(0, Math.sin(p + 2.2)) * (0.5 + 0.4 * run) * amp;
      L.foot.rotation.x = -(L.top.rotation.x + L.mid.rotation.x + L.hock.rotation.x);
    }
  }
  const deerOK = (x, z) => inMeadow(x, z, -5) && -z < edgeZ(x) - 2.5 && !onSlab(x, z, 1.8) && Math.hypot(x - CRASH.c.x, z - CRASH.c.z) > 12 && Math.hypot(x - CRASH.wing.x, z - CRASH.wing.z) > 7;
  function spotNear(cx, cz, rmin, rmax, ok) {
    for (let k = 0; k < 40; k++) { const a = rng() * Math.PI * 2, r = rand(rmin, rmax), x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r; if (ok(x, z)) return [x, z]; }
    return [cx * 0.7, cz * 0.7];
  }
  [[true, 8, -11], [false, 9.6, -9.4]].forEach(([stag, x, z], i) => {
    wild.deer.push({ m: makeDeer(stag), stag, pos: new THREE.Vector3(x, 0, z), heading: rand(-3, 3), speed: 0, phase: rng() * 6, mode: 'graze',
      timer: rand(4, 9), lookTimer: rand(2, 5), headUp: 0, graze: 1, tailUp: 0, target: new THREE.Vector3(x, 0, z), seed: i * 3.7 });
  });

  // coat variants: red, eastern grey, and the melanistic black morph
  const SQ_COATS = [
    { fur: 0xa4552a, belly: 0xeadbc4, tail: 0xb4652f, tip: 0x6b3016 },
    { fur: 0x7f7b75, belly: 0xece6dc, tail: 0x948d85, tip: 0x4a4541 },
    { fur: 0x2f2825, belly: 0x5b4d43, tail: 0x3b322c, tip: 0x171210 }
  ];
  function makeSquirrel(coat = SQ_COATS[0]) {
    const fur = furSolid(coat.fur), cream = furSolid(coat.belly);
    const tailM = new THREE.MeshStandardMaterial({ color: lin(coat.tail), roughness: 1, normalMap: furN, normalScale: new THREE.Vector2(1.5, 1.5) });
    const dark = new THREE.MeshStandardMaterial({ color: lin(coat.tip), roughness: 1 });
    const eye = new THREE.MeshStandardMaterial({ color: lin(0x050302), roughness: 0.04, envMap: envTex, envMapIntensity: 1.4 });
    const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
    mk(new THREE.SphereGeometry(0.06, 16, 12), fur, 0, 0.075, 0, body).scale.set(0.72, 0.78, 1.25);
    mk(new THREE.SphereGeometry(0.05, 12, 10), cream, 0, 0.06, 0.018, body).scale.set(0.6, 0.7, 1.0);
    for (const s of [-1, 1]) {
      mk(new THREE.SphereGeometry(0.042, 12, 10), fur, 0.03 * s, 0.055, -0.045, body).scale.set(0.8, 1, 1.1);
      mk(new THREE.SphereGeometry(0.02, 10, 8), fur, 0.03 * s, 0.012, -0.02, body).scale.set(0.7, 0.4, 1.9);
    }
    const head = new THREE.Group(); head.position.set(0, 0.11, 0.075); body.add(head);
    mk(new THREE.SphereGeometry(0.038, 16, 12), fur, 0, 0, 0, head).scale.set(0.9, 0.9, 1.1);
    mk(new THREE.SphereGeometry(0.022, 12, 10), fur, 0, -0.008, 0.034, head);
    mk(new THREE.SphereGeometry(0.018, 10, 8), cream, 0, -0.016, 0.03, head).scale.set(1, 0.6, 1);
    mk(new THREE.SphereGeometry(0.0065, 8, 6), new THREE.MeshStandardMaterial({ color: lin(0x1a1010), roughness: 0.3 }), 0, -0.002, 0.055, head);
    for (const s of [-1, 1]) {
      mk(new THREE.SphereGeometry(0.0095, 10, 8), eye, 0.023 * s, 0.01, 0.022, head, false);
      mk(new THREE.ConeGeometry(0.011, 0.03, 8), fur, 0.02 * s, 0.04, -0.008, head);
      mk(new THREE.ConeGeometry(0.005, 0.026, 6), dark, 0.02 * s, 0.062, -0.01, head);
    }
    const paws = [];
    for (const s of [-1, 1]) { const pw = new THREE.Group(); pw.position.set(0.022 * s, 0.06, 0.07); body.add(pw); mk(new THREE.CylinderGeometry(0.008, 0.006, 0.05, 6), fur, 0, -0.025, 0, pw); paws.push(pw); }
    const tail = []; let parent = new THREE.Group(); parent.position.set(0, 0.07, -0.075); parent.rotation.x = -1.0; body.add(parent);
    [0.022, 0.03, 0.037, 0.043, 0.044, 0.04, 0.031].forEach((r, i) => {
      const sg = new THREE.Group(); if (i) sg.position.y = 0.04; parent.add(sg);
      mk(new THREE.SphereGeometry(r, 12, 10), tailM, 0, 0.02, 0, sg).scale.set(0.8, 1.3, 1);
      tail.push(sg); parent = sg;
    });
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    mergeRig(g, { bones: rigParts(body, head, paws, tail) }); scene.add(g);
    return { g, body, head, paws, tail };
  }
  function nearestTree(x, z, maxD = 1e9) {
    let best = null, bd = maxD;
    for (const tr of nearTrees) { const d = Math.hypot(tr.x - x, tr.z - z); if (d < bd) { bd = d; best = tr; } }
    return best;
  }
  const trunkR = (tr, y) => { const f = Math.min(1, y / tr.h); return tr.baseR * tr.h * (1 - 0.75 * f) * (1 + 1.8 * Math.pow(1 - sstep(f, 0, 0.05), 2)) + 0.045; };
  const usedTrees = new Set();
  // the first six live at the forest edge; the rest on trees closer to the meadow paths, so they're easier to spot
  [[-17, -7], [15, 9], [-15, 15], [19, -6], [7, 20], [-21, 1], [-11, -13], [12, -2], [-10, 8], [11, 15], [-4, 19], [4, -17]].forEach(([x, z], i) => {
    let home = null, bd = 1e9;
    for (const tr of nearTrees) { if (usedTrees.has(tr)) continue; const d = Math.hypot(tr.x - x, tr.z - z); if (d < bd) { bd = d; home = tr; } }
    if (!home) return; usedTrees.add(home);
    const toC = Math.atan2(-home.x, -home.z);
    const sx = home.x + Math.sin(toC) * 2.5, sz = home.z + Math.cos(toC) * 2.5;
    wild.squirrels.push({ m: makeSquirrel(SQ_COATS[i < 6 ? 0 : i % 3]), home, tree: home, pos: new THREE.Vector3(sx, 0, sz), heading: toC, speed: 0, hop: 0, mode: 'forage', timer: rand(1, 3),
      target: new THREE.Vector3(sx, 0, sz), y: 0, ang: 0, upright: 1, seed: i * 5.3, qd: new THREE.Quaternion() });
  });

  // ---------- small birds that fly free over the meadow and rest on the rocks ----------
  const BIRD_KINDS = [
    { back: 0x5e5146, breast: 0xd0642a, belly: 0xe9e1d2, tip: 0x3f362f, beak: 0x2a2018 },   // robin
    { back: 0x6b7f4e, breast: 0xd8bf3e, belly: 0xe4d672, tip: 0x3d6aa6, beak: 0x24201c },   // blue tit
    { back: 0x7a5a3c, breast: 0xb4a894, belly: 0xd8cfbe, tip: 0x4a3524, beak: 0x3a3028 },   // sparrow
    { back: 0x1d1b1b, breast: 0x242120, belly: 0x2b2826, tip: 0x121010, beak: 0xd98a1e }    // blackbird
  ];
  function makeBird(c) {
    const back = furSolid(c.back), breast = furSolid(c.breast), pale = furSolid(c.belly), tip = furSolid(c.tip);
    const horn = new THREE.MeshStandardMaterial({ color: lin(c.beak), roughness: 0.5 });
    const eye = new THREE.MeshStandardMaterial({ color: lin(0x050302), roughness: 0.04, envMap: envTex, envMapIntensity: 1.4 });
    const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
    mk(new THREE.SphereGeometry(0.05, 16, 12), back, 0, 0, 0, body).scale.set(0.82, 0.8, 1.35);
    mk(new THREE.SphereGeometry(0.044, 14, 10), breast, 0, -0.008, 0.026, body).scale.set(0.84, 0.86, 1.0);
    mk(new THREE.SphereGeometry(0.036, 12, 10), pale, 0, -0.022, -0.02, body).scale.set(0.8, 0.6, 1.2);
    const head = new THREE.Group(); head.position.set(0, 0.036, 0.058); body.add(head);
    mk(new THREE.SphereGeometry(0.031, 14, 12), back, 0, 0, 0, head);
    mk(new THREE.SphereGeometry(0.026, 12, 10), breast, 0, -0.01, 0.01, head).scale.set(0.95, 0.8, 1);
    { const bk = mk(new THREE.ConeGeometry(0.0075, 0.03, 8), horn, 0, -0.002, 0.04, head); bk.rotation.x = Math.PI / 2; }
    for (const s of [-1, 1]) mk(new THREE.SphereGeometry(0.0062, 8, 6), eye, 0.021 * s, 0.006, 0.016, head, false);
    const wings = [];
    for (const s of [-1, 1]) {
      const w = new THREE.Group(); w.position.set(0.032 * s, 0.018, 0.005); body.add(w);
      mk(new THREE.SphereGeometry(0.05, 12, 8), back, 0.05 * s, 0, -0.008, w).scale.set(1.25, 0.14, 0.62);
      mk(new THREE.SphereGeometry(0.04, 10, 6), tip, 0.085 * s, -0.002, -0.02, w).scale.set(1.0, 0.1, 0.45);
      w.userData.s = s; wings.push(w);
    }
    const tail = new THREE.Group(); tail.position.set(0, 0.008, -0.06); body.add(tail);
    mk(new THREE.SphereGeometry(0.04, 10, 6), tip, 0, 0, -0.035, tail).scale.set(0.75, 0.14, 1.1);
    const legs = new THREE.Group(); legs.position.set(0, -0.035, 0.005); body.add(legs);
    for (const s of [-1, 1]) mk(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 5), horn, 0.014 * s, -0.015, 0, legs);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.scale.setScalar(1.3);
    mergeRig(g, { bones: rigParts(body, head, wings, tail, legs) }); scene.add(g);
    return { g, body, head, wings, tail, legs };
  }
  const BIRD_FOOT = 0.07;   // body centre sits this high above whatever it stands on
  // a spot in the air somewhere around the astronaut, so the birds stay in view while roaming freely
  function birdWaypoint(B, c = state.pos) {
    const a = rng() * Math.PI * 2, r = rand(3, 14), x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r;
    B.wp.set(x, surfaceY(x, z) + rand(1.4, 4.5), z);
  }
  // a free rock, preferring ones near the astronaut
  function pickPerch(c = state.pos) {
    const free = PERCHES.filter(pc => !pc.taken);
    if (!free.length) return null;
    free.sort((a, b) => Math.hypot(a.p.x - c.x, a.p.z - c.z) - Math.hypot(b.p.x - c.x, b.p.z - c.z));
    return free[Math.floor(rng() * Math.min(5, free.length))];
  }
  const birds = [], birdStart = new THREE.Vector3(0.5, 0, -2);   // `state` doesn't exist yet, so seed around his start point
  for (let i = 0; i < (isSmall ? 4 : 7); i++) {
    const B = {
      m: makeBird(BIRD_KINDS[i % BIRD_KINDS.length]), pos: new THREE.Vector3(), vel: new THREE.Vector3(), wp: new THREE.Vector3(),
      mode: 'fly', perch: null, flyT: rand(4, 12), restT: 0, landed: false,
      flap: rng() * 6, glide: 0, burst: 0, yaw: rng() * 6, pitch: 0, seed: i * 2.9,
      target: new THREE.Vector3(), tmp: new THREE.Vector3()
    };
    // about half start out sitting on a rock, the rest already on the wing
    const pc = i % 2 === 0 ? pickPerch(birdStart) : null;
    if (pc) { pc.taken = B; B.perch = pc; B.mode = 'rest'; B.landed = true; B.restT = rand(3, 12); B.pos.copy(pc.p); B.pos.y += BIRD_FOOT; }
    else { const x = rand(-6, 6), z = rand(-6, 4); B.pos.set(x, heightAt(x, z) + rand(2, 4), z); }
    birdWaypoint(B, birdStart);
    birds.push(B);
  }

  const wv = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4(), lamp: new THREE.Vector3(), dir: new THREE.Vector3() };
  function threatFrom(x, z) {
    const ax = x - state.pos.x, az = z - state.pos.z, dA = Math.hypot(ax, az);
    const bx = x - state.dog.pos.x, bz = z - state.dog.pos.z, dB = Math.hypot(bx, bz) * 0.8;   // the dog is scarier
    const seatedCalm = state.sit > 0.5 ? 1.8 : 1;                                         // a sitting astronaut is less alarming
    const dAeff = dA * seatedCalm;
    return dAeff < dB ? { d: dAeff, away: Math.atan2(ax, az) } : { d: dB, away: Math.atan2(bx, bz) };
  }
  const DEER_STATUS = { graze: 'Grazing', walk: 'Wandering', alert: 'Alert', flee: 'Bolting' };

  function updateWildlife(dt, t) {
    const U = lantern.userData; U.light.getWorldPosition(wv.lamp);
    // ---------------- deer ----------------
    wild.deer.forEach((A, idx) => {
      const leader = idx > 0 ? wild.deer[0] : null;
      const th = threatFrom(A.pos.x, A.pos.z);
      const fleeR = 6.5, alertR = 12;
      if (A.mode !== 'flee' && th.d < fleeR) {
        A.mode = 'flee'; A.timer = 7; A.tailUp = 1;
        const [x, z] = spotNear(A.pos.x + Math.sin(th.away) * 15, A.pos.z + Math.cos(th.away) * 15, 0, 5, deerOK); A.target.set(x, 0, z);
        if (leader === null && wild.deer[1] && wild.deer[1].mode !== 'flee') { const B = wild.deer[1]; B.mode = 'flee'; B.timer = 7; B.tailUp = 1; B.target.set(x + 1.5, 0, z + 1); }
      } else if ((A.mode === 'graze' || A.mode === 'walk') && th.d < alertR) { A.mode = 'alert'; A.timer = rand(2, 3.5); }
      let want = 0;
      const tdx = A.target.x - A.pos.x, tdz = A.target.z - A.pos.z, td = Math.hypot(tdx, tdz);
      if (A.mode === 'graze') {
        A.timer -= dt; A.lookTimer -= dt;
        if (A.lookTimer < 0) { A.headUp = A.headUp ? 0 : 1; A.lookTimer = A.headUp ? rand(1.2, 2.6) : rand(3, 7); }
        if (A.timer <= 0) {
          A.mode = 'walk'; A.headUp = 0;
          const [x, z] = leader ? spotNear(leader.pos.x, leader.pos.z, 1.6, 3.5, deerOK) : spotNear(A.pos.x, A.pos.z, 3, 9, deerOK);
          A.target.set(x, 0, z);
        }
      } else if (A.mode === 'walk') {
        want = 0.7; if (td < 0.5) { A.mode = 'graze'; A.timer = rand(6, 14); A.lookTimer = rand(2, 5); }
      } else if (A.mode === 'alert') {
        A.timer -= dt;
        A.heading = wrap(A.heading + wrap(th.away + Math.PI - A.heading) * Math.min(1, dt * 2.2));
        if (A.timer <= 0) {
          if (th.d < alertR) { A.mode = 'walk'; const [x, z] = spotNear(A.pos.x + Math.sin(th.away) * 8, A.pos.z + Math.cos(th.away) * 8, 0, 3, deerOK); A.target.set(x, 0, z); }
          else { A.mode = 'graze'; A.timer = rand(5, 10); A.lookTimer = rand(1, 3); }
        }
      } else if (A.mode === 'flee') {
        want = 5.4; A.timer -= dt;
        if (td < 1.2 || A.timer <= 0) { A.mode = 'alert'; A.timer = rand(2.5, 4); }
      }
      if (want > 0) A.heading = wrap(A.heading + wrap(Math.atan2(tdx, tdz) - A.heading) * Math.min(1, dt * (A.mode === 'flee' ? 4 : 1.7)));
      A.speed += (want - A.speed) * Math.min(1, dt * (want > A.speed ? 2.2 : 2.8));
      const nx = A.pos.x + Math.sin(A.heading) * A.speed * dt, nz = A.pos.z + Math.cos(A.heading) * A.speed * dt;
      if (deerOK(nx, nz) && !obstacleHit(nx, nz, 0.45)) { A.pos.x = nx; A.pos.z = nz; }
      else { A.heading = wrap(A.heading + wrap(Math.atan2(-A.pos.x, -A.pos.z - 4) - A.heading) * Math.min(1, dt * 3)); const [x, z] = spotNear(A.pos.x * 0.6, A.pos.z * 0.6, 0, 4, deerOK); A.target.set(x, 0, z); }
      wild.deer.forEach(B => { if (B === A) return; const dx = A.pos.x - B.pos.x, dz = A.pos.z - B.pos.z, d = Math.hypot(dx, dz); if (d < 1.4 && d > 1e-3) { A.pos.x += dx / d * (1.4 - d) * 0.5; A.pos.z += dz / d * (1.4 - d) * 0.5; } });
      const run = sstep(A.speed, 1.5, 3.5), amp = Math.min(1, A.speed / 0.55);
      A.phase += A.speed * dt / (run > 0.5 ? 2.6 : 1.15) * Math.PI * 2;
      const p = A.phase, M = A.m, a2 = amp * (1 + 0.25 * run);
      if (run > 0.5) { deerLeg(M.fl, p, true, a2, run); deerLeg(M.fr, p + 0.35, true, a2, run); deerLeg(M.hl, p + Math.PI, false, a2, run); deerLeg(M.hr, p + Math.PI + 0.35, false, a2, run); }
      else { deerLeg(M.hl, p, false, amp, 0); deerLeg(M.fl, p + Math.PI / 2, true, amp, 0); deerLeg(M.hr, p + Math.PI, false, amp, 0); deerLeg(M.fr, p + Math.PI * 1.5, true, amp, 0); }
      M.body.position.y = run * Math.abs(Math.sin(p)) * 0.13 + (1 - run) * Math.abs(Math.sin(p * 2)) * 0.012 * amp;
      M.body.rotation.x = run * Math.sin(p) * 0.09;
      const grazing = A.mode === 'graze' && !A.headUp ? 1 : 0, alertUp = (A.mode === 'alert' || A.mode === 'flee') ? 1 : 0;
      A.graze += (grazing - A.graze) * Math.min(1, dt * 1.6);
      M.neck.rotation.x = 0.75 + A.graze * 1.72 - alertUp * 0.12 + run * 0.35;
      M.head.rotation.x = -0.95 - A.graze * 0.3 + alertUp * 0.15 + (A.graze > 0.8 ? Math.sin(t * 5.5 + A.seed) * 0.05 : 0);
      M.head.rotation.y = (A.mode === 'graze' && A.headUp) ? Math.sin(t * 0.7 + A.seed) * 0.45 : 0;
      M.ears.forEach((e, i) => { const s = i ? 1 : -1; e.rotation.z = -1.0 * s + (alertUp ? 0.55 * s : 0) + (Math.sin(t * 0.9 + i * 2.3 + A.seed) > 0.96 ? 0.35 * s : 0); e.rotation.x = alertUp ? -0.25 : 0; });
      A.tailUp = A.mode === 'flee' ? 1 : Math.max(0, A.tailUp - dt * 0.25);
      M.tail.rotation.x = -0.15 - A.tailUp * 1.5 - (A.mode !== 'flee' && Math.sin(t * 2.7 + A.seed) > 0.9 ? 0.5 : 0);
      M.g.position.set(A.pos.x, heightAt(A.pos.x, A.pos.z), A.pos.z);
      M.g.rotation.y += wrap(A.heading - M.g.rotation.y) * Math.min(1, dt * 6);
      // eyeshine: lantern light reflecting back from the eyes
      M.head.getWorldPosition(wv.a); M.head.getWorldDirection(wv.b);
      wv.dir.copy(wv.lamp).sub(wv.a); const ld = wv.dir.length(); wv.dir.divideScalar(ld);
      const facing = Math.max(0, wv.b.dot(wv.dir));
      const shine = state.lamp ? Math.pow(facing, 6) * Math.max(0, 1 - ld / 24) * state.glow : 0;
      M.eyeMat.emissive.setRGB(1.6, 1.9, 1.0).multiplyScalar(shine * 2.2);
    });
    if (wild.deer[0]) veg.uP2.value.set(wild.deer[0].pos.x, 0, wild.deer[0].pos.z);
    if (wild.deer[1]) veg.uP3.value.set(wild.deer[1].pos.x, 0, wild.deer[1].pos.z);

    // ---------------- squirrels ----------------
    wild.squirrels.forEach(Sq => {
      const M = Sq.m, ground = Sq.mode === 'forage' || Sq.mode === 'hop' || Sq.mode === 'flee';
      const th = threatFrom(Sq.pos.x, Sq.pos.z);
      if (ground && Sq.mode !== 'flee' && th.d < 4.5) { Sq.mode = 'flee'; Sq.tree = nearestTree(Sq.pos.x, Sq.pos.z, 14) || Sq.home; }
      let sp = 0;
      if (Sq.mode === 'forage') {
        Sq.timer -= dt;
        if (Sq.timer <= 0) {
          Sq.mode = 'hop';
          const tr = Sq.home, toC = Math.atan2(-tr.x, -tr.z) + rand(-1.1, 1.1), r = rand(1.2, 5.5);
          Sq.target.set(tr.x + Math.sin(toC) * r, 0, tr.z + Math.cos(toC) * r);
        }
      } else if (Sq.mode === 'hop') {
        sp = 1.5; if (Math.hypot(Sq.target.x - Sq.pos.x, Sq.target.z - Sq.pos.z) < 0.15) { Sq.mode = 'forage'; Sq.timer = rand(1.5, 4.5); }
      } else if (Sq.mode === 'flee') {
        const tr = Sq.tree, out = Math.atan2(Sq.pos.x - tr.x, Sq.pos.z - tr.z), R = trunkR(tr, 0.1);
        Sq.target.set(tr.x + Math.sin(out) * R, 0, tr.z + Math.cos(out) * R);
        sp = 4.2;
        if (Math.hypot(Sq.target.x - Sq.pos.x, Sq.target.z - Sq.pos.z) < 0.12) { Sq.mode = 'climb'; Sq.ang = out; Sq.y = 0.08; Sq.perchH = THREE.MathUtils.clamp(tr.crown * tr.h - 0.4, 1.6, 4.0); }
      } else if (Sq.mode === 'climb') {
        Sq.y += 1.4 * dt; Sq.ang += 0.5 * dt;
        if (Sq.y >= Sq.perchH) { Sq.mode = 'perch'; Sq.timer = rand(6, 12); }
      } else if (Sq.mode === 'perch') {
        Sq.timer -= dt; if (Sq.timer <= 0 && th.d > 7) Sq.mode = 'descend';
      } else if (Sq.mode === 'descend') {
        Sq.y -= 1.0 * dt; Sq.ang -= 0.3 * dt;
        if (Sq.y <= 0.06) {
          Sq.mode = 'forage'; Sq.timer = rand(1, 2.5); Sq.y = 0;
          const tr = Sq.tree, R = trunkR(tr, 0.1) + 0.12;
          Sq.pos.set(tr.x + Math.sin(Sq.ang) * R, 0, tr.z + Math.cos(Sq.ang) * R); Sq.heading = Sq.ang; Sq.home = tr;
        }
      }
      if (ground) {
        if (sp > 0) {
          const dx = Sq.target.x - Sq.pos.x, dz = Sq.target.z - Sq.pos.z, d = Math.hypot(dx, dz);
          Sq.heading = wrap(Sq.heading + wrap(Math.atan2(dx, dz) - Sq.heading) * Math.min(1, dt * 12));
          const stepL = Math.min(d, sp * dt * (0.55 + 0.9 * Math.max(0, Math.sin(Sq.hop * Math.PI * 2))));
          Sq.pos.x += Math.sin(Sq.heading) * stepL; Sq.pos.z += Math.cos(Sq.heading) * stepL;
          Sq.hop += dt * (sp > 2 ? 6.5 : 4.2);
        }
        Sq.upright += ((Sq.mode === 'forage' ? 1 : 0) - Sq.upright) * Math.min(1, dt * 7);
        const hopY = sp > 0 ? Math.abs(Math.sin(Sq.hop * Math.PI)) * (sp > 2 ? 0.1 : 0.065) : 0;
        M.g.position.set(Sq.pos.x, heightAt(Sq.pos.x, Sq.pos.z) + hopY, Sq.pos.z);
        Sq.qd.setFromAxisAngle(UP, Sq.heading);
        M.body.rotation.x = -1.05 * Sq.upright + (sp > 0 ? Math.sin(Sq.hop * Math.PI * 2) * 0.28 : 0);
        M.body.position.set(0, 0.02 * Sq.upright, -0.04 * Sq.upright);
      } else {
        const tr = Sq.tree, R = trunkR(tr, Sq.y);
        const ox = Math.sin(Sq.ang), oz = Math.cos(Sq.ang);
        M.g.position.set(tr.x + ox * R, tr.y0 + Sq.y, tr.z + oz * R);
        const yA = wv.a.set(ox, 0, oz), zA = wv.b.set(0, Sq.mode === 'climb' ? 1 : -1, 0), xA = wv.c.crossVectors(yA, zA);
        wv.m.makeBasis(xA, yA, zA); Sq.qd.setFromRotationMatrix(wv.m);
        Sq.upright += (0 - Sq.upright) * Math.min(1, dt * 7);
        M.body.rotation.x = Sq.mode === 'perch' ? 0 : Math.sin(t * 18) * 0.08; M.body.position.set(0, 0, 0);
      }
      M.g.quaternion.slerp(Sq.qd, Math.min(1, dt * 12));
      const nib = Sq.mode === 'forage' && Sq.upright > 0.7;
      M.head.rotation.x = nib ? 0.35 + Math.sin(t * 16 + Sq.seed) * 0.06 : (Sq.mode === 'perch' ? Math.sin(t * 0.8 + Sq.seed) * 0.2 : 0);
      M.head.rotation.y = (Sq.mode === 'perch' || (Sq.mode === 'forage' && !nib)) ? Math.sin(t * 1.3 + Sq.seed) * 0.5 : 0;
      M.paws.forEach(pw => { pw.rotation.x = nib ? -1.3 : (Sq.mode === 'hop' || Sq.mode === 'flee' ? Math.sin(Sq.hop * Math.PI * 2) * 0.6 : 0); });
      const flick = Math.max(0, Math.sin(t * 2.3 + Sq.seed * 2)) > 0.92 ? 0.25 : 0;
      M.tail.forEach((sg, i) => { sg.rotation.x = 0.36 + Math.sin(t * 3 + i * 0.6 + Sq.seed) * 0.04 + flick * (i < 3 ? 1 : -0.5) + (Sq.mode === 'flee' ? -0.25 : 0); });
    });

    updateBirds(dt, t);
  }

  function updateBirds(dt, t) { birds.forEach(B => updateBird(B, dt, t)); }

  function updateBird(B, dt, t) {
    const M = B.m;
    // ----- decide: roam → pick a rock → land → rest → take off again -----
    if (B.mode === 'fly') {
      B.flyT -= dt;
      if (B.pos.distanceTo(B.wp) < 1.2) birdWaypoint(B);
      if (B.flyT <= 0) {
        const pc = pickPerch();
        if (pc) { pc.taken = B; B.perch = pc; B.mode = 'land'; } else B.flyT = rand(3, 6);
      }
    } else if (B.mode === 'rest') {
      B.restT -= dt;
      const th = threatFrom(B.pos.x, B.pos.z);
      if (B.restT <= 0 || th.d < 2.4) {   // bored, or something big walked up: off it goes
        B.perch.taken = null; B.perch = null; B.mode = 'fly'; B.landed = false;
        B.vel.set(Math.sin(th.away) * 1.5, 2.2, Math.cos(th.away) * 1.5);
        B.flyT = rand(6, 16); birdWaypoint(B);
      }
    }

    const T = B.target;
    if (B.mode === 'fly') T.copy(B.wp);
    else { T.copy(B.perch.p); T.y += BIRD_FOOT; }

    if (B.landed) {
      B.pos.copy(T); B.vel.set(0, 0, 0);
      if (Math.sin(t * 0.6 + B.seed) > 0.97) B.yaw += dt * 3;   // shuffles round on the rock now and then
    } else {
      // steer: cruise toward waypoints, ease in when coming down to a rock
      const d = B.tmp.copy(T).sub(B.pos), dist = d.length();
      const sp = B.mode === 'fly' ? 4.5 : Math.min(4.0, dist * 2.4);
      d.multiplyScalar(sp / (dist || 1));
      B.vel.lerp(d, Math.min(1, dt * (B.mode === 'fly' ? 1.8 : 4.5)));
      if (B.mode === 'fly') B.vel.y -= 1.8 * dt * B.glide;   // undulating flight: sinks a little during each glide
      birds.forEach(O => {   // keep a little personal space in the air
        if (O === B || O.landed) return;
        const ox = B.pos.x - O.pos.x, oy = B.pos.y - O.pos.y, oz = B.pos.z - O.pos.z, od = Math.hypot(ox, oy, oz);
        if (od < 0.7 && od > 1e-3) { const k = (0.7 - od) / od * dt * 6; B.vel.x += ox * k; B.vel.y += oy * k; B.vel.z += oz * k; }
      });
      B.pos.addScaledVector(B.vel, dt);
      const floor = surfaceY(B.pos.x, B.pos.z) + BIRD_FOOT;
      if (B.pos.y < floor) { B.pos.y = floor; if (B.vel.y < 0) B.vel.y = 0; }
      if (B.mode === 'land' && dist < 0.08) { B.mode = 'rest'; B.landed = true; B.restT = rand(5, 14); }
      const hs = Math.hypot(B.vel.x, B.vel.z);
      if (hs > 0.15) B.yaw += wrap(Math.atan2(B.vel.x, B.vel.z) - B.yaw) * Math.min(1, dt * 7);
      B.pitch += (THREE.MathUtils.clamp(-Math.atan2(B.vel.y, hs + 0.5), -0.6, 0.6) - B.pitch) * Math.min(1, dt * 5);
    }

    // wings: bursts of fast flapping between short glides; folded along the back when landed
    const climbing = B.vel.y > 0.4 || B.mode === 'land';
    B.burst -= dt;
    if (B.burst <= 0) { B.glide = (B.mode === 'fly' && !climbing && !B.glide) ? 1 : 0; B.burst = B.glide ? rand(0.35, 0.75) : rand(0.6, 1.4); }
    const flapping = !B.landed && (climbing || !B.glide);
    if (flapping) B.flap += dt * 22;
    M.wings.forEach(w => {
      const s = w.userData.s, open = flapping ? Math.sin(B.flap) + 0.15 : (B.landed ? 0 : 0.12);
      w.rotation.y += ((B.landed ? 1.35 * s : 0) - w.rotation.y) * Math.min(1, dt * 12);
      w.rotation.z = s * open;
    });
    M.legs.scale.y += ((B.landed || B.mode === 'land' ? 1 : 0.2) - M.legs.scale.y) * Math.min(1, dt * 8);
    M.tail.rotation.x = B.landed ? -0.25 + Math.max(0, Math.sin(t * 3.1 + B.seed)) * 0.25 : 0.05 * Math.sin(B.flap);

    // on the rock: pecks at the lichen, quick glances about
    const peck = B.landed && Math.sin(t * 1.3 + B.seed) > 0.45;
    const glance = Math.sin(t * 2.3 + B.seed * 1.7);
    M.head.rotation.x = peck ? 0.9 + Math.max(0, Math.sin(t * 14)) * 0.35 : 0;
    M.head.rotation.y = B.landed && !peck ? (glance > 0.5 ? 0.6 : glance < -0.5 ? -0.6 : 0) : 0;

    M.g.position.copy(B.pos);
    if (flapping) M.g.position.y += Math.sin(B.flap) * 0.008;
    M.g.rotation.set(0, B.yaw, 0);
    M.body.rotation.x = B.landed ? (peck ? 0.35 : -0.12) : B.pitch;
  }

  await step('Setting the lens', 0.83);
  // ======================================================================
  // POST-PROCESSING
  // ======================================================================
  let composer = null, bloom = null, outPass = null;
  if (canPost) {
    const w = stage.clientWidth * PR, h = stage.clientHeight * PR;
    const hdrType = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : (renderer.extensions.get('OES_texture_half_float') ? THREE.HalfFloatType : THREE.UnsignedByteType);
    const rt = renderer.capabilities.isWebGL2 && THREE.WebGLMultisampleRenderTarget
      ? new THREE.WebGLMultisampleRenderTarget(w, h, { type: hdrType, format: THREE.RGBAFormat })
      : new THREE.WebGLRenderTarget(w, h, { type: hdrType, format: THREE.RGBAFormat });
    composer = new THREE.EffectComposer(renderer, rt);
    composer.setSize(stage.clientWidth, stage.clientHeight);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloom = new THREE.UnrealBloomPass(new THREE.Vector2(stage.clientWidth, stage.clientHeight), 0.75, 0.55, 0.85);
    composer.addPass(bloom);
    outPass = new THREE.ShaderPass({
      uniforms: { tDiffuse: { value: null }, uExposure: { value: 1.32 }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uExposure, uTime; varying vec2 vUv;
        vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03))/(x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }
        void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
          c = aces(c); c = pow(c, vec3(1.0/2.2));
          vec2 q = vUv - 0.5; c *= 1.0 - 0.32*dot(q, q)*1.6;
          float n = fract(sin(dot(vUv*1000.0 + uTime, vec2(12.9898,78.233)))*43758.5453);
          c += (n - 0.5) / 255.0;
          gl_FragColor = vec4(c, 1.0); }`
    });
    composer.addPass(outPass);
  }

  // ======================================================================
  // RAIN: drop sizes follow the Marshall–Palmer distribution, every drop falls at its own
  // terminal velocity (Atlas et al. 1973) and drifts with the wind; drops hitting the ground
  // throw secondary droplets on ballistic arcs. Drops only show where light reaches them.
  // ======================================================================
  const rain = (() => {
    const BOX = 26, H = 16;                       // world-anchored volume of drops kept around the camera (m)
    const MAX = Math.round(26000 * (isSmall ? 0.45 : 1));
    const D_MIN = 0.5, D_MAX = 3.5;               // mm; smaller drops are too faint to see as streaks
    const EXPOSURE = 1 / 40;                      // streak = distance fallen in this "shutter" time, as the eye sees rain
    const G = 9.81;
    const WIND_DIR = new THREE.Vector2(1, 0.45).normalize(); // same direction the grass bends
    const vTerm = D => 9.65 - 10.3 * Math.exp(-0.6 * D);    // terminal velocity, m/s (D in mm)
    const rateOf = a => 12 * a * a;                          // slider 0..1 → rainfall rate in mm/h
    const lambdaOf = R => 4.1 * Math.pow(Math.max(R, 0.05), -0.21); // Marshall–Palmer slope, mm⁻¹
    // Visible drops per m³ ∝ ∫_{D_MIN}^∞ e^(−ΛD) dD; normalised so the heaviest setting uses the whole pool.
    const visDensity = R => { const l = lambdaOf(R); return Math.exp(-l * D_MIN) / l; };
    const sampleD = l => D_MIN - Math.log(1 - Math.random() * (1 - Math.exp(-l * (D_MAX - D_MIN)))) / l;

    const lightU = {
      uL0: { value: new THREE.Vector3() }, uC0: { value: new THREE.Vector3() },
      uL1: { value: new THREE.Vector3() }, uC1: { value: new THREE.Vector3() },
      uL2: { value: new THREE.Vector3() }, uC2: { value: new THREE.Vector3() },
      uAmb: { value: new THREE.Vector3() }, uCam: { value: new THREE.Vector3() }
    };
    // Raindrops scatter light strongly forward: a drop between you and a lamp glints, one beside it barely shows.
    const LIGHT_GLSL = `uniform vec3 uL0, uC0, uL1, uC1, uL2, uC2, uAmb, uCam;
      vec3 dropLight(vec3 L, vec3 C, vec3 p, vec3 vd){ vec3 d = L - p; float r2 = dot(d, d); vec3 ld = d * inversesqrt(r2);
        float ph = 0.18 + 2.4 * pow(max(dot(vd, ld), 0.0), 6.0); return C * ph / (1.0 + 1.6 * r2); }
      vec3 rainLight(vec3 p){ vec3 vd = normalize(p - uCam);
        return uAmb + dropLight(uL0, uC0, p, vd) + dropLight(uL1, uC1, p, vd) + dropLight(uL2, uC2, p, vd); }`;

    // ----- falling drops: line segments, head + tail vertex per drop, animated entirely on the GPU -----
    const seed = new Float32Array(MAX * 6), aEnd = new Float32Array(MAX * 2), aD = new Float32Array(MAX * 2);
    for (let i = 0; i < MAX; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      seed.set([x, y, z, x, y, z], i * 6); aEnd[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(seed, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(aEnd, 1));
    const dAttr = new THREE.BufferAttribute(aD, 1); g.setAttribute('aD', dAttr);
    const U = Object.assign({ uT: { value: 0 }, uWindOff: { value: new THREE.Vector2() }, uWindVel: { value: new THREE.Vector2() },
      uBox: { value: BOX }, uH: { value: H }, uExp: { value: EXPOSURE }, uGain: { value: 1 } }, lightU);
    const mat = new THREE.ShaderMaterial({
      uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `uniform vec3 uCam; uniform vec2 uWindOff, uWindVel; uniform float uT, uBox, uH, uExp;
        attribute float aEnd, aD; varying vec3 vW; varying float vA;
        void main(){
          float vt = 9.65 - 10.3 * exp(-0.6 * aD);
          vec3 p;  // fixed in the world, wrapped into a box that travels with the camera
          p.x = uCam.x + mod(position.x * uBox + uWindOff.x - uCam.x + 0.5 * uBox, uBox) - 0.5 * uBox;
          p.z = uCam.z + mod(position.z * uBox + uWindOff.y - uCam.z + 0.5 * uBox, uBox) - 0.5 * uBox;
          p.y = uCam.y + mod(position.y * uH - vt * uT - uCam.y + 0.5 * uH, uH) - 0.5 * uH;
          p -= vec3(uWindVel.x, -vt, uWindVel.y) * uExp * aEnd;   // tail = where the drop was one exposure ago
          vW = p;
          float dc = distance(p, uCam);
          vA = smoothstep(0.3, 1.0, dc) * (1.0 - smoothstep(uBox * 0.28, uBox * 0.5, dc))
             * (0.35 + 0.65 * aD / 2.0) * (1.0 - 0.55 * aEnd);   // bigger drops scatter more; head brighter than tail
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `uniform float uGain; varying vec3 vW; varying float vA; ${LIGHT_GLSL}
        void main(){ gl_FragColor = vec4(rainLight(vW) * vA * uGain * 0.65, 1.0); }`
    });
    const drops = new THREE.LineSegments(g, mat); drops.frustumCulled = false; drops.renderOrder = 7; scene.add(drops);

    // ----- splashes: secondary droplets on ballistic arcs (CPU, small pool) -----
    const SP = isSmall ? 400 : 1000;
    const sPos = new Float32Array(SP * 3).fill(-1e4), sVel = new Float32Array(SP * 3), sFloor = new Float32Array(SP), sLife = new Float32Array(SP);
    const sg = new THREE.BufferGeometry(); const sAttr = new THREE.BufferAttribute(sPos, 3); sAttr.setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('position', sAttr);
    const sm = new THREE.ShaderMaterial({
      uniforms: Object.assign({ uPR: prU, uGain: U.uGain }, lightU), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `uniform float uPR; varying vec3 vW; void main(){ vW = position; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv; gl_PointSize = clamp(uPR * 5.0 / -mv.z, 1.0, 3.0 * uPR); }`,
      fragmentShader: `uniform float uGain; varying vec3 vW; ${LIGHT_GLSL}
        void main(){ vec2 q = gl_PointCoord - 0.5; float a = smoothstep(0.25, 0.1, dot(q, q));
          gl_FragColor = vec4(rainLight(vW) * a * uGain * 0.5, 1.0); }`
    });
    const splashes = new THREE.Points(sg, sm); splashes.frustumCulled = false; splashes.renderOrder = 7; scene.add(splashes);
    let sNext = 0, sAcc = 0;
    function splash(x, z, l) {
      const y = heightAt(x, z), v = vTerm(sampleD(l)), n = 2 + (Math.random() * 4 | 0);
      for (let k = 0; k < n; k++) {
        const i = sNext; sNext = (sNext + 1) % SP;
        const th = Math.random() * Math.PI * 2, el = (35 + Math.random() * 40) * Math.PI / 180;
        const sp = v * (0.12 + Math.random() * 0.18);   // ejecta leave at a fraction of the impact speed
        sPos[i * 3] = x; sPos[i * 3 + 1] = y + 0.005; sPos[i * 3 + 2] = z;
        sVel[i * 3] = Math.cos(th) * Math.cos(el) * sp; sVel[i * 3 + 1] = Math.sin(el) * sp; sVel[i * 3 + 2] = Math.sin(th) * Math.cos(el) * sp;
        sFloor[i] = y; sLife[i] = 1;
      }
    }

    const R = { amount: 0, rate: 0, lambda: 4.1, windOff: new THREE.Vector2() };
    function setAmount(a) {
      R.amount = a; R.rate = rateOf(a); R.lambda = lambdaOf(R.rate);
      for (let i = 0; i < MAX; i++) { const D = sampleD(R.lambda); aD[i * 2] = aD[i * 2 + 1] = D; }
      dAttr.needsUpdate = true;
      const n = a <= 0 ? 0 : Math.round(MAX * Math.min(1, visDensity(R.rate) / visDensity(rateOf(1))));
      g.setDrawRange(0, n * 2);
      drops.visible = splashes.visible = n > 0;
    }
    const lampLight = lantern.userData.light;
    function setLight(L, C, light) { light.getWorldPosition(L.value); C.value.set(light.color.r, light.color.g, light.color.b).multiplyScalar(light.intensity); }

    function update(dt, t) {
      if (!drops.visible) return;
      // gusty wind: drops pick up the air's horizontal speed within a fraction of a second, so they move with it
      const ws = 1.3 * (1 + 0.3 * Math.sin(t * 0.23) + 0.15 * Math.sin(t * 0.61 + 2));
      U.uWindVel.value.copy(WIND_DIR).multiplyScalar(ws);
      R.windOff.addScaledVector(U.uWindVel.value, dt);
      R.windOff.set(R.windOff.x % BOX, R.windOff.y % BOX);
      U.uWindOff.value.copy(R.windOff);
      U.uT.value = t % 1000;
      lightU.uCam.value.copy(camera.position);
      setLight(lightU.uL0, lightU.uC0, lampLight);
      setLight(lightU.uL1, lightU.uC1, wreck.fire1);
      setLight(lightU.uL2, lightU.uC2, wreck.fire2);
      lightU.uAmb.value.set(0.16, 0.19, 0.26).multiplyScalar(state.moonGain);

      // splashes: impacts land on the ground near the astronaut, at a rate that scales with the rainfall
      sAcc += R.rate * 70 * dt;
      while (sAcc >= 1) {
        sAcc--;
        const a = Math.random() * Math.PI * 2, rr = 6 * Math.sqrt(Math.random());
        splash(controls.target.x + Math.cos(a) * rr, controls.target.z + Math.sin(a) * rr, R.lambda);
      }
      for (let i = 0; i < SP; i++) {
        if (sLife[i] <= 0) continue;
        sVel[i * 3 + 1] -= G * dt;
        sPos[i * 3] += sVel[i * 3] * dt; sPos[i * 3 + 1] += sVel[i * 3 + 1] * dt; sPos[i * 3 + 2] += sVel[i * 3 + 2] * dt;
        if (sPos[i * 3 + 1] < sFloor[i]) { sLife[i] = 0; sPos[i * 3 + 1] = -1e4; }
      }
      sAttr.needsUpdate = true;
    }
    setAmount(0.3);
    return { setAmount, update };
  })();

  await step('Charting paths', 0.86);
  // ======================================================================
  // STATE & CONTROLS
  // ======================================================================
  const NAV = (() => {
    const x0 = -27, z0 = -39, cs = 0.5, nx = 108, nz = 132, N = nx * nz;
    const grid = new Uint8Array(N);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = walkable(x0 + (i + 0.5) * cs, z0 + (j + 0.5) * cs, 0.45) ? 1 : 0;
    const cellOf = (x, z) => [Math.floor((x - x0) / cs), Math.floor((z - z0) / cs)];
    const ok = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz && grid[j * nx + i] === 1;
    const center = (i, j) => [x0 + (i + 0.5) * cs, z0 + (j + 0.5) * cs];
    function nearestFree(i, j) {
      if (ok(i, j)) return [i, j];
      for (let r = 1; r < 24; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) { if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; if (ok(i + di, j + dj)) return [i + di, j + dj]; }
      return null;
    }
    function lineFree(ax, az, bx, bz) {
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.2);
      for (let k = 1; k < n; k++) { const t = k / n, c = cellOf(ax + (bx - ax) * t, az + (bz - az) * t); if (!ok(c[0], c[1])) return false; }
      return true;
    }
    function plan(ax, az, bx, bz) {
      const s = nearestFree(...cellOf(ax, az)), g = nearestFree(...cellOf(bx, bz));
      if (!s || !g) return [[bx, bz]];
      const si = s[1] * nx + s[0], gi = g[1] * nx + g[0];
      const gS = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
      const hv = [], hf = [];
      const push = (f, v) => { hv.push(v); hf.push(f); let i = hv.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (hf[q] <= hf[i]) break; [hv[q], hv[i]] = [hv[i], hv[q]]; [hf[q], hf[i]] = [hf[i], hf[q]]; i = q; } };
      const pop = () => { const top = hv[0], lv = hv.pop(), lf = hf.pop(); if (hv.length) { hv[0] = lv; hf[0] = lf; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hv.length && hf[l] < hf[m]) m = l; if (r < hv.length && hf[r] < hf[m]) m = r; if (m === i) break; [hv[m], hv[i]] = [hv[i], hv[m]]; [hf[m], hf[i]] = [hf[i], hf[m]]; i = m; } } return top; };
      const H = (idx) => { const i = idx % nx, j = (idx / nx) | 0, di = Math.abs(i - g[0]), dj = Math.abs(j - g[1]); return Math.max(di, dj) + 0.414 * Math.min(di, dj); };
      gS[si] = 0; push(H(si), si);
      let found = si === gi;
      while (hv.length && !found) {
        const idx = pop(); if (closed[idx]) continue; closed[idx] = 1;
        if (idx === gi) { found = true; break; }
        const ci = idx % nx, cj = (idx / nx) | 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue; const ni = ci + di, nj = cj + dj; if (!ok(ni, nj)) continue;
          if (di && dj && (!ok(ci + di, cj) || !ok(ci, cj + dj))) continue;
          const n = nj * nx + ni, ng = gS[idx] + (di && dj ? 1.414 : 1);
          if (ng < gS[n]) { gS[n] = ng; came[n] = idx; push(ng + H(n), n); }
        }
      }
      if (!found) return [[bx, bz]];
      const cells = []; for (let c = gi; c !== -1; c = came[c]) { cells.push(center(c % nx, (c / nx) | 0)); if (c === si) break; }
      cells.reverse();
      // string-pull into a few straight legs
      const out = []; let cur = [ax, az], k = 0;
      while (k < cells.length - 1) { let m = cells.length - 1; while (m > k + 1 && !lineFree(cur[0], cur[1], cells[m][0], cells[m][1])) m--; out.push(cells[m]); cur = cells[m]; k = m; }
      out.push([bx, bz]);
      return out;
    }
    return { plan, lineFree };
  })();
  function firstBlocker(ax, az, bx, bz) {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.3);
    for (let k = 1; k < n; k++) { const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (crashBlocked(x, z, 0.3)) return 'wreck'; const o = obstacleHit(x, z, 0.4); if (o) return o.type === 'fire' ? 'fire' : o.type === 'wreckage' ? 'wreck' : o.type === 'tree' ? 'fallen tree' : 'rocks'; }
    return null;
  }
  const state = {
    auto: true, lamp: true, follow: true, glow: 1, moonGain: 1,
    pos: new THREE.Vector3(0.5, 0, -2), heading: Math.PI, speed: 0, phase: 0, walked: 0,
    wp: new THREE.Vector3(CRASH.view.x, 0, CRASH.view.z), wpLookout: false, wpWreck: true, leg: 1, look: 0, inspectT: 0,
    path: null, pathIdx: 0, pathKey: '', detour: 0, detourWhat: '', stuckT: 0, lastPos: new THREE.Vector3(0.5, 0, -2),
    mode: 'walk', sit: 0, seatTimer: 0, wantStand: false, still: 0, lastInteract: -99,
    dog: { pos: new THREE.Vector3(-0.6, 0, -0.4), heading: Math.PI, speed: 0, phase: 0, sit: 0, still: 0, wag: 0 }
  };
  const keys = new Set(), moveKeys = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
  on(window, 'keydown', e => {
    const k = e.key.toLowerCase();
    if (moveKeys.includes(k)) { keys.add(k); if (state.auto) setAuto(false); e.preventDefault(); }
    if (k === 'e') toggleSit(true);
  });
  on(window, 'keyup', e => keys.delete(e.key.toLowerCase()));
  on(window, 'blur', () => keys.clear());
  controls.addEventListener('start', () => { state.lastInteract = clock.elapsedTime; });
  function setAuto(v) { state.path = null; state.auto = v; }
  function setLamp(v) { state.lamp = v; }
  function setFollow(v) { state.follow = v; }
  let camTween = null;
  function moonView() {
    const md = new THREE.Vector3(MOON_DIR.x, 0, MOON_DIR.z).normalize();
    const side = new THREE.Vector3(-md.z, 0, md.x);
    const seated = state.mode !== 'walk';
    const to = new THREE.Vector3().addScaledVector(md, seated ? -3.0 : -3.4).addScaledVector(side, seated ? 0.75 : 0.7);
    to.y = seated ? 0.15 : -0.3;
    camTween = { from: camera.position.clone().sub(controls.target), to, t: 0 };
    setFollow(true);
  }
  function toggleSit(fromKey) {
    if (state.mode === 'seated' || state.mode === 'sitting') { state.wantStand = true; return; }
    if (state.mode !== 'walk') return;
    const d = Math.hypot(LEDGE.seat.x - state.pos.x, LEDGE.seat.z - state.pos.z);
    if (fromKey && !state.auto) { if (d < 1.4) state.mode = 'turn'; return; }
    setAuto(true); state.wp.copy(LEDGE.seat); state.wpLookout = true;
  }
  if (reduceMotion) setAuto(false);

  function pickWaypoint() {
    state.leg++;
    state.wpWreck = false;
    if (state.leg % 3 === 0) { state.wp.copy(LEDGE.seat); state.wpLookout = true; }
    else if (state.leg % 3 === 1) { state.wp.set(CRASH.view.x, 0, CRASH.view.z); state.wpLookout = false; state.wpWreck = true; }
    else {
      let x, z, k = 0; do { x = rand(-13, 13); z = rand(-20, 14); k++; } while ((!inMeadow(x, z, 3) || crashBlocked(x, z, 2.5) || obstacleHit(x, z, 1.2)) && k < 80);
      state.wp.set(x, 0, z); state.wpLookout = false;
    }
  }
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const groundY = (v) => surfaceY(v.x, v.z);
  camera.position.set(state.pos.x + 2.3, groundY(state.pos) + 2.0, state.pos.z + 5.4);
  controls.target.set(state.pos.x, groundY(state.pos) + 1.35, state.pos.z);

  // ======================================================================
  // LOOP
  // ======================================================================
  const clock = new THREE.Clock();
  const prev = new THREE.Vector3(), tv = new THREE.Vector3(), fwd = new THREE.Vector3(), rgt = new THREE.Vector3();
  const qYaw = new THREE.Quaternion(), qSwing = new THREE.Quaternion(), qHand = new THREE.Quaternion(), eul = new THREE.Euler();
  const qHang = new THREE.Quaternion(), handPos = new THREE.Vector3(), restPos = new THREE.Vector3();
  const SH_R = -0.74, EL_R = -0.62;
  const STATUS = { inspect: 'Inspecting the wreck', walk: 'Walking', turn: 'At the edge', sitting: 'Sitting down', seated: 'Watching the moon', standing: 'Getting up' };

  function tick() {
    if (disposed) return;
    const raw = clock.getDelta(), dt = Math.min(raw, 0.05), t = clock.elapsedTime;
    adaptQuality(raw, t);
    veg.uTime.value = t; skyUniforms.uTime.value = t;
    prev.copy(state.pos);

    // ----- astronaut behaviour: walk → turn to the moon → sit → watch → stand -----
    let targetSpeed = 0;
    const moving = moveKeys.some(k => keys.has(k));
    const sdx = LEDGE.seat.x - state.pos.x, sdz = LEDGE.seat.z - state.pos.z, seatD = Math.hypot(sdx, sdz);
    if (state.mode === 'walk') {
      if (state.auto) {
        const toWp = tv.set(state.wp.x - state.pos.x, 0, state.wp.z - state.pos.z), d = toWp.length();
        if (d < (state.wpLookout ? 0.45 : 0.6)) { if (state.wpLookout) state.mode = 'turn'; else if (state.wpWreck) { state.mode = 'inspect'; state.inspectT = 8; } else pickWaypoint(); }
        else {
          const key = state.wp.x.toFixed(2) + ',' + state.wp.z.toFixed(2);
          if (!state.path || state.pathKey !== key) {
            state.path = NAV.plan(state.pos.x, state.pos.z, state.wp.x, state.wp.z); state.pathIdx = 0; state.pathKey = key;
            const what = firstBlocker(state.pos.x, state.pos.z, state.wp.x, state.wp.z);
            if (what && state.path.length > 1) { state.detour = 5; state.detourWhat = what; }
          }
          let node = state.path[state.pathIdx];
          while (state.pathIdx < state.path.length - 1 && Math.hypot(node[0] - state.pos.x, node[1] - state.pos.z) < 0.55) node = state.path[++state.pathIdx];
          if (state.pathIdx < state.path.length - 1) { const nn = state.path[state.pathIdx + 1]; if (NAV.lineFree(state.pos.x, state.pos.z, nn[0], nn[1])) node = state.path[++state.pathIdx]; }
          let dx = node[0] - state.pos.x, dz = node[1] - state.pos.z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
          // step aside for deer that wander into the way
          wild.deer.forEach(A => {
            const ex = A.pos.x - state.pos.x, ez = A.pos.z - state.pos.z, ed = Math.hypot(ex, ez);
            if (ed < 2.6 && ed > 0.01 && (ex * dx + ez * dz) / ed > 0.2) { const side = (ex * dz - ez * dx) > 0 ? -1 : 1, w = (2.6 - ed) / 2.6 * 1.3, px = -dz * side, pz = dx * side; dx += px * w; dz += pz * w; }
          });
          const want = Math.atan2(dx, dz) + Math.sin(t * 0.35) * 0.05;
          const turn = wrap(want - state.heading);
          state.heading = wrap(state.heading + turn * Math.min(1, dt * 3));
          targetSpeed = (state.wpLookout && d < 3 ? 0.35 + d * 0.15 : Math.min(1.05, d * 0.6 + 0.2)) * (0.45 + 0.55 * Math.max(0, Math.cos(turn)));
          // if he makes no progress for a while, plan again from where he is
          state.stuckT += dt;
          if (state.stuckT > 1.6) { if (state.pos.distanceTo(state.lastPos) < 0.25) state.path = null; state.lastPos.copy(state.pos); state.stuckT = 0; }
        }
      } else {
        fwd.set(state.pos.x - camera.position.x, 0, state.pos.z - camera.position.z).normalize();
        rgt.set(-fwd.z, 0, fwd.x); tv.set(0, 0, 0);
        if (keys.has('w') || keys.has('arrowup')) tv.add(fwd);
        if (keys.has('s') || keys.has('arrowdown')) tv.sub(fwd);
        if (keys.has('d') || keys.has('arrowright')) tv.add(rgt);
        if (keys.has('a') || keys.has('arrowleft')) tv.sub(rgt);
        if (tv.lengthSq() > 0) { tv.normalize(); state.heading = wrap(state.heading + wrap(Math.atan2(tv.x, tv.z) - state.heading) * Math.min(1, dt * 7)); targetSpeed = 1.45; }
        // stand still near the ledge for a moment and he sits down by himself
        if (!moving && seatD < 1.2 && state.speed < 0.05) { state.still += dt; if (state.still > 1.6) state.mode = 'turn'; } else state.still = 0;
      }
    } else if (state.mode === 'inspect') {
      const want = Math.atan2(CRASH.c.x - state.pos.x, CRASH.c.z - state.pos.z);
      state.heading = wrap(state.heading + wrap(want - state.heading) * Math.min(1, dt * 2.2));
      state.inspectT -= dt;
      if (moving || !state.auto) state.mode = 'walk';
      else if (state.inspectT <= 0) { state.mode = 'walk'; pickWaypoint(); }
    } else if (state.mode === 'turn') {
      state.heading = wrap(state.heading + wrap(LEDGE.face - state.heading) * Math.min(1, dt * 2.6));
      state.pos.x += sdx * Math.min(1, dt * 2.5); state.pos.z += sdz * Math.min(1, dt * 2.5);
      if (Math.abs(wrap(LEDGE.face - astro.rotation.y)) < 0.05 && seatD < 0.06) {
        state.mode = 'sitting'; state.still = 0;
        if (state.follow && t - state.lastInteract > 6) moonView();
      }
      if (moving) state.mode = 'walk';
    } else if (state.mode === 'sitting') {
      state.sit = Math.min(1, state.sit + dt / 2.6);
      if (state.sit >= 1) { state.mode = 'seated'; state.seatTimer = 26; }
      if (moving || state.wantStand) state.mode = 'standing';
    } else if (state.mode === 'seated') {
      if (state.auto) { state.seatTimer -= dt; if (state.seatTimer <= 0) state.mode = 'standing'; }
      if (moving || state.wantStand) state.mode = 'standing';
    } else if (state.mode === 'standing') {
      state.sit = Math.max(0, state.sit - dt / 2.0);
      if (state.sit <= 0) { state.mode = 'walk'; state.wantStand = false; if (state.auto) pickWaypoint(); }
    }
    if (state.mode === 'walk') {
      state.speed += (targetSpeed - state.speed) * Math.min(1, dt * 3.5);
      const nx = state.pos.x + Math.sin(state.heading) * state.speed * dt, nz = state.pos.z + Math.cos(state.heading) * state.speed * dt;
      if (walkable(nx, nz)) { state.pos.x = nx; state.pos.z = nz; }
      else if (walkable(nx, state.pos.z)) state.pos.x = nx;
      else if (walkable(state.pos.x, nz)) state.pos.z = nz;
    } else state.speed += (0 - state.speed) * Math.min(1, dt * 6);
    const step = Math.hypot(state.pos.x - prev.x, state.pos.z - prev.z);
    state.walked += step; state.phase += step / 1.38 * Math.PI * 2;
    const gy = state.sit > 0 ? LEDGE.top : groundY(state.pos);
    astro.position.set(state.pos.x, gy, state.pos.z);
    astro.rotation.y += wrap(state.heading - astro.rotation.y) * Math.min(1, dt * 6);

    // ----- pose: walking gait blended with the seated pose (legs dangling over the drop) -----
    const aSit = state.sit, se = aSit * aSit * (3 - 2 * aSit);
    const mixv = (a, b) => a + (b - a) * se;
    const ph = state.phase, amt = Math.min(1, state.speed / 0.9) * (1 - se);
    const sL = Math.sin(ph), sR = Math.sin(ph + Math.PI);
    const kickL = Math.sin(t * 0.9) * 0.16, kickR = Math.sin(t * 0.9 + 2.2) * 0.16;
    legL.thigh.rotation.x = mixv(-sL * 0.48 * amt, -1.5); legR.thigh.rotation.x = mixv(-sR * 0.48 * amt, -1.5);
    legL.thigh.rotation.z = mixv(0, 0.09); legR.thigh.rotation.z = mixv(0, -0.09);
    legL.knee.rotation.x = mixv((0.06 + Math.max(0, Math.sin(ph + 1.9)) * 0.9) * amt, 1.42 + kickL);
    legR.knee.rotation.x = mixv((0.06 + Math.max(0, Math.sin(ph + Math.PI + 1.9)) * 0.9) * amt, 1.42 + kickR);
    legL.ankle.rotation.x = mixv(-legL.thigh.rotation.x * 0.3 - legL.knee.rotation.x * 0.45, -0.12);
    legR.ankle.rotation.x = mixv(-legR.thigh.rotation.x * 0.3 - legR.knee.rotation.x * 0.45, -0.12);
    aBody.position.y = (Math.abs(Math.cos(ph)) - 0.6) * 0.032 * amt;
    pelvis.position.y = mixv(0.96, 0.17);
    pelvis.rotation.y = Math.sin(ph) * 0.07 * amt; pelvis.rotation.z = Math.cos(ph) * 0.025 * amt;
    torso.rotation.y = -Math.sin(ph) * 0.1 * amt;
    torso.rotation.x = mixv(0.05 * Math.min(1, state.speed / 0.9), -0.2 + Math.sin(t * 0.5) * 0.015);
    armL.upper.rotation.set(mixv(Math.sin(ph) * 0.42 * amt, 0.38), 0, mixv(0.12, 0.26));
    armL.elbow.rotation.x = mixv(-0.3 - Math.max(0, Math.sin(ph)) * 0.35 * amt, -0.12);
    armR.upper.rotation.set(mixv(SH_R + Math.sin(ph * 2) * 0.025 * amt, -0.45), 0, mixv(-0.14, -0.12));
    armR.elbow.rotation.x = mixv(EL_R, -0.95);
    const lookUp = (state.mode === 'walk' || state.mode === 'inspect') ? 0 : 1;
    state.look += (lookUp - state.look) * Math.min(1, dt * 1.2);
    head.rotation.x = -0.34 * state.look + Math.sin(ph * 2) * 0.012 * amt;
    head.rotation.y = Math.sin(t * 0.33) * 0.13 * state.look * se;
    if (state.mode === 'inspect') { head.rotation.y = Math.sin(t * 0.55) * 0.38; head.rotation.x = 0.06; }

    // ----- lantern: pendulum physics from the hand; set down on the rock when he sits -----
    armR.hand.updateWorldMatrix(true, false);
    armR.hand.getWorldPosition(handPos);
    handPos.add(tv.set(0, -0.11, 0).applyQuaternion(armR.hand.getWorldQuaternion(qHand)));
    const LP = lanternPhys, ls = sstep(aSit, 0.35, 0.85);
    if (!LP.init || ls > 0.5) { LP.b.copy(handPos); LP.b.y -= LP.L; LP.bp.copy(LP.b); LP.piv.copy(handPos); LP.bFrame.copy(LP.b); LP.vPrev.set(0, 0, 0); LP.acc.set(0, 0, 0); LP.init = true; }
    else {
      const SUB = 4, h = dt / SUB;
      for (let k = 0; k < SUB; k++) {
        const piv = tv.copy(LP.piv).lerp(handPos, (k + 1) / SUB);
        const vx = (LP.b.x - LP.bp.x) * 0.994, vy = (LP.b.y - LP.bp.y) * 0.994, vz = (LP.b.z - LP.bp.z) * 0.994;
        LP.bp.copy(LP.b);
        LP.b.x += vx; LP.b.y += vy - 9.81 * h * h; LP.b.z += vz;
        const dx = LP.b.x - piv.x, dy = LP.b.y - piv.y, dz = LP.b.z - piv.z, len = Math.hypot(dx, dy, dz) || 1;
        LP.b.set(piv.x + dx / len * LP.L, piv.y + dy / len * LP.L, piv.z + dz / len * LP.L);
      }
      LP.piv.copy(handPos);
      if (dt > 0) {
        const vx = (LP.b.x - LP.bFrame.x) / dt, vy = (LP.b.y - LP.bFrame.y) / dt, vz = (LP.b.z - LP.bFrame.z) / dt;
        const ax = (vx - LP.vPrev.x) / dt, ay = (vy - LP.vPrev.y) / dt, az = (vz - LP.vPrev.z) / dt;
        LP.acc.lerp(tv.set(ax, ay, az), Math.min(1, dt * 3)); if (LP.acc.length() > 7) LP.acc.setLength(7);
        LP.vPrev.set(vx, vy, vz); LP.bFrame.copy(LP.b);
      }
    }
    LP.yaw += wrap(astro.rotation.y - LP.yaw) * Math.min(1, dt * 2.5);
    qYaw.setFromAxisAngle(UP, LP.yaw);
    const hangDir = tv.copy(LP.b).sub(handPos).normalize();
    qHang.setFromUnitVectors(new THREE.Vector3(0, -1, 0), hangDir).multiply(qYaw);
    const rx = -Math.cos(LEDGE.face), rz = Math.sin(LEDGE.face);
    const gx = LEDGE.seat.x + rx * 0.46 - LEDGE.fx * 0.14, gz = LEDGE.seat.z + rz * 0.46 - LEDGE.fz * 0.14;
    restPos.set(gx, surfaceY(gx, gz) + 0.355, gz);
    lantern.position.copy(handPos).lerp(restPos, ls);
    qSwing.setFromAxisAngle(UP, LEDGE.face);
    lantern.quaternion.copy(qHang).slerp(qSwing, ls);
    lantern.updateMatrixWorld(true);
    // flame: leans with the lantern's acceleration (buoyancy in an accelerating frame) and flickers more when shaken
    const U = lantern.userData, on = state.lamp ? 1 : 0;
    const aMag = LP.acc.length();
    const fdir = tv.set(LP.acc.x * 0.7 * (1 - ls), 9.81 + LP.acc.y * 0.7 * (1 - ls), LP.acc.z * 0.7 * (1 - ls)).normalize();
    qSwing.setFromUnitVectors(UP, fdir);
    U.flameG.quaternion.copy(lantern.quaternion).invert().multiply(qSwing);
    const flick = 0.9 + Math.sin(t * 7.3) * 0.03 + Math.sin(t * 13.1 + Math.sin(t * 2.1) * 2) * 0.035 + (vnoise3(t * 9, 1, 2) - 0.5) * (0.08 + Math.min(0.25, aMag * 0.02));
    U.fu.uFlick.value = 0.92 + (flick - 0.9) * 2.2; U.fu.uOn.value = on;
    U.light.intensity = 4.6 * flick * state.glow * on;
    U.halo.visible = !!on;
    U.halo.scale.set(0.16 * Math.sqrt(state.glow) * flick, 0.2 * Math.sqrt(state.glow) * flick, 1);
    U.glassMat.emissiveIntensity = on ? 0.3 * flick * state.glow : 0.0;
    U.light.getWorldPosition(handPos);
    lanternRays.update(handPos, lantern.quaternion, surfaceY(handPos.x, handPos.z), 0.0105 * flick * state.glow * on, dt, t);

    // ----- dog follows -----
    const D = state.dog;
    const ah = astro.rotation.y, standing = state.speed < 0.15;
    const seatedNow = state.sit > 0.15 || state.mode === 'turn';
    const offBack = seatedNow ? 0.02 : standing ? -0.35 : -1.45, offSide = seatedNow ? 0.82 : standing ? 0.85 : -0.7;
    const tgx = state.pos.x + Math.sin(ah) * offBack + Math.cos(ah) * offSide;
    const tgz = state.pos.z + Math.cos(ah) * offBack - Math.sin(ah) * offSide;
    const ddx = tgx - D.pos.x, ddz = tgz - D.pos.z, dd = Math.hypot(ddx, ddz);
    const wantSp = dd > 0.25 ? Math.min(3.0, (dd - 0.15) * 2.4) : 0;
    D.speed += (wantSp - D.speed) * Math.min(1, dt * 3);
    if (dd > 0.25) D.heading = wrap(D.heading + wrap(Math.atan2(ddx, ddz) - D.heading) * Math.min(1, dt * 5));
    else D.heading = wrap(D.heading + wrap((state.sit > 0.3 ? LEDGE.face : ah) - D.heading) * Math.min(1, dt * 2));
    const dPrevX = D.pos.x, dPrevZ = D.pos.z;
    { const nx = D.pos.x + Math.sin(D.heading) * D.speed * dt, nz = D.pos.z + Math.cos(D.heading) * D.speed * dt;
      const dogBlocked = (x, z) => dd < 9 && (crashBlocked(x, z, -0.45) || !!obstacleHit(x, z, 0.18));
      if (!dogBlocked(nx, nz)) { D.pos.x = nx; D.pos.z = nz; }
      else if (!dogBlocked(nx, D.pos.z)) D.pos.x = nx;
      else if (!dogBlocked(D.pos.x, nz)) D.pos.z = nz;
      else { const side = D.heading + Math.PI / 2; D.pos.x += Math.sin(side) * D.speed * dt * 0.6; D.pos.z += Math.cos(side) * D.speed * dt * 0.6; if (dogBlocked(D.pos.x, D.pos.z)) { D.pos.x = dPrevX; D.pos.z = dPrevZ; } } }
    const ax = D.pos.x - state.pos.x, az = D.pos.z - state.pos.z, ad = Math.hypot(ax, az);
    if (ad < 0.65) { D.pos.x = state.pos.x + ax / ad * 0.65; D.pos.z = state.pos.z + az / ad * 0.65; }
    const dStep = Math.hypot(D.pos.x - dPrevX, D.pos.z - dPrevZ);
    D.phase += dStep / 0.9 * Math.PI * 2;
    D.still = D.speed < 0.08 ? D.still + dt : 0;
    const wantSit = (D.still > 1.2 && standing) ? 1 : 0;
    D.sit += (wantSit - D.sit) * Math.min(1, dt * 2.5);
    dog.position.set(D.pos.x, groundY(D.pos), D.pos.z);
    dog.rotation.y += wrap(D.heading - dog.rotation.y) * Math.min(1, dt * 8);
    const da = Math.min(1, D.speed / 1.2), dp = D.phase, s = D.sit;
    const legSwing = (L, p, front) => {
      if (front) {
        L.top.rotation.x = Math.sin(p) * 0.55 * da + 0.5 * s;
        L.mid.rotation.x = Math.max(0, Math.sin(p + 1.3)) * 1.0 * da;
        L.foot.rotation.x = -L.mid.rotation.x * 0.4;
      } else {
        L.top.rotation.x = 0.35 + Math.sin(p) * 0.45 * da - 1.45 * s;
        L.mid.rotation.x = -0.85 - Math.max(0, Math.sin(p + 1.6)) * 0.45 * da + 1.9 * s * 0 - 0.6 * s;
        L.hock.rotation.x = 0.5 + Math.max(0, Math.sin(p + 2.2)) * 0.4 * da + 2.05 * s;
        L.foot.rotation.x = -(L.top.rotation.x + L.mid.rotation.x + L.hock.rotation.x);
      }
    };
    legSwing(fl, dp, true); legSwing(hr, dp, false); legSwing(fr, dp + Math.PI, true); legSwing(hl, dp + Math.PI, false);
    dRoot.rotation.x = -0.52 * s;
    dRoot.position.y = 0.5 - 0.31 * s + Math.abs(Math.sin(dp)) * 0.02 * da;
    dRoot.rotation.z = Math.sin(dp) * 0.03 * da;
    dNeck.rotation.x = 0.8 + Math.sin(dp * 2) * 0.05 * da - 0.25 * s;
    dHead.rotation.x = -0.8 + 0.25 * s - (state.sit > 0.5 ? 0.2 * s : 0);
    dHead.rotation.y = Math.sin(t * 0.7) * 0.18 * (1 - da);
    ears.forEach((e, i) => { e.rotation.x = Math.sin(dp * 2 + i) * 0.22 * da + 0.05; });
    jaw.rotation.x = 0.18 + Math.sin(t * 9) * 0.06 * (0.4 + da);
    tongue.visible = da > 0.2 || s > 0.5;
    D.wag += dt * (7 + da * 3);
    tailSegs.forEach((sg, i) => { sg.rotation.z = Math.sin(D.wag - i * 0.55) * (0.22 + 0.1 * (1 - da)); sg.rotation.x = -0.12 + s * 0.05; });

    updateWildlife(dt, t);
    wreck.update(dt, t);
    veg.uP0.value.set(state.pos.x, 0, state.pos.z);
    veg.uP1.value.set(D.pos.x, 0, D.pos.z);
    fireflies.update(t);
    groundMist.update(dt);
    grimeU.value = astro.position.y;

    // ----- lights follow the action -----
    moonLight.position.set(state.pos.x + MOON_DIR.x * 80, gy + MOON_DIR.y * 80 + 18, state.pos.z + MOON_DIR.z * 80);
    moonLight.target.position.set(state.pos.x, gy, state.pos.z);
    moonLight.intensity = 0.8 * state.moonGain; hemi.intensity = 0.9 * state.moonGain; fill.intensity = 0.5 * state.moonGain;
    skyUniforms.uSkyGain.value = 0.75 + 0.25 * state.moonGain;

    // ----- camera -----
    const tgt = tv.set(state.pos.x, gy + 1.35 - 0.5 * se, state.pos.z);
    if (camTween) {
      camTween.t = Math.min(1, camTween.t + dt / 2.2);
      const e = camTween.t < 0.5 ? 2 * camTween.t * camTween.t : 1 - Math.pow(-2 * camTween.t + 2, 2) / 2;
      const off = camTween.from.clone().lerp(camTween.to, e);
      controls.target.copy(tgt);
      camera.position.copy(controls.target).add(off);
      if (camTween.t >= 1) camTween = null;
    } else if (state.follow) {
      const dx = state.pos.x - prev.x, dz = state.pos.z - prev.z;
      camera.position.x += dx; camera.position.z += dz;
      controls.target.lerp(tgt, Math.min(1, dt * 4));
    }
    controls.update();
    const camGround = heightAt(camera.position.x, camera.position.z) + 0.35;
    if (camera.position.y < camGround) camera.position.y = camGround;
    skyGroup.position.copy(camera.position);

    // ----- HUD -----
    const deg = ((THREE.MathUtils.radToDeg(-astro.rotation.y + Math.PI) % 360) + 360) % 360;
    state.detour = Math.max(0, state.detour - dt);
    const hud = {
      heading: String(Math.round(deg)).padStart(3, '0') + '°',
      walked: state.walked.toFixed(1) + ' m',
      o2: Math.max(12, 98 - Math.floor(state.walked / 45)) + '%',
      status: (state.mode === 'walk' && state.auto && state.detour > 0) ? `Walking around the ${state.detourWhat}` : STATUS[state.mode],
      seated: state.mode === 'seated' || state.mode === 'sitting',
      deer: wild.deer[0] ? DEER_STATUS[wild.deer[0].mode] : '—',
      dog: D.sit > 0.6 ? 'Sitting' : D.speed > 1.6 ? 'Catching up' : D.speed > 0.1 ? 'Following' : 'Waiting',
      birds: (n => `${birds.length - n} flying · ${n} on rocks`)(birds.filter(b => b.landed).length),
      auto: state.auto, lamp: state.lamp, follow: state.follow
    };
    // Push to React immediately when a toggle changes (so buttons respond at once), otherwise ~7 times a second.
    const flags = `${hud.auto}|${hud.lamp}|${hud.follow}|${hud.seated}`;
    if (flags !== hudFlags || t - hudAt > 0.15) { hudFlags = flags; hudAt = t; onHud(hud); }
    rain.update(dt, t);

    updateVegLOD(camera.position);
    updateShadowMaps();
    if (composer) { outPass.uniforms.uTime.value = t % 10; composer.render(); } else renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }

  // ---------- shadow-map updates ----------
  // A point light's shadow is six extra renders of every caster near it, every frame. The fire never moves and nearly
  // everything it lights is static, so its map is redrawn only while something that moves is close enough for its
  // shadow to show (the fire's light is ~3% of its near-field strength beyond 12 m), plus a refresh every 20 frames.
  // The lantern's map isn't redrawn while the lamp is off: its light is zero then, so the map is never seen.
  const fireShadow = wreck.fire1 && wreck.fire1.castShadow ? wreck.fire1.shadow : null;
  const lampShadow = lantern.userData.light.shadow;
  if (fireShadow) fireShadow.autoUpdate = false;
  lampShadow.autoUpdate = false;
  let shadowFrame = 0;
  function updateShadowMaps() {
    shadowFrame++;
    lampShadow.needsUpdate = state.lamp;
    if (!fireShadow) return;
    // something that moves, near the fire, and has moved since the fire's map was last drawn
    let stale = shadowFrame % 20 === 1;
    for (const [o, r2] of fireMovers) {
      if (stale) break;
      const last = o.userData.fireSeen || (o.userData.fireSeen = new THREE.Vector3(1e9, 0, 0));
      stale = o.position.distanceToSquared(fireP) < r2 && o.position.distanceToSquared(last) > 1e-4;
    }
    fireShadow.needsUpdate = stale;
    if (stale) for (const [o] of fireMovers) (o.userData.fireSeen || (o.userData.fireSeen = new THREE.Vector3())).copy(o.position);
  }
  // big movers count within 12 m of the fire; a squirrel's or bird's shadow is too small to see beyond 5 m
  const fireP = wreck.fire1.position;
  const fireMovers = [[astro, 144], [dog, 144], ...wild.deer.map(A => [A.m.g, 144]), ...wild.squirrels.map(Sq => [Sq.m.g, 25]), ...birds.map(B => [B.m.g, 25])];

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) { composer.setSize(w, h); bloom.setSize(w, h); }
    wreck.resize();
  }
  on(window, 'resize', resize);

  // ---------- adaptive quality ----------
  // Full quality whenever the GPU keeps up. If frames run long (under ~45 fps) for a few seconds, step down one notch
  // of a ladder, cheapest-to-lose first: pixel density on a HiDPI screen down to 1.25, then the density of grass beyond
  // 14 m (down to half), then pixel density down to 1. After a long stretch at full speed, step back up.
  // Fast hardware never leaves the top rung.
  const ladder = [];
  for (let pr = PR_MAX; pr >= Math.min(PR_MAX, 1.25) - 1e-6; pr -= 0.25) ladder.push([pr, 1]);
  for (const vd of [0.8, 0.65, 0.5]) ladder.push([ladder[ladder.length - 1][0], vd]);
  for (let pr = ladder[ladder.length - 1][0] - 0.25; pr >= PR_MIN - 1e-6; pr -= 0.25) ladder.push([pr, 0.5]);
  let rung = 0, frameAvg = 1 / 60, rungAt = 0, droppedAt = -1e9;
  function adaptQuality(raw, t) {
    if (raw > 0.25) return;                       // tab was hidden or the page stalled: not a rendering signal
    frameAvg += (raw - frameAvg) * 0.04;
    if (t - rungAt < 2.5) return;
    let next = rung;
    if (frameAvg > 1 / 45 && rung < ladder.length - 1) { next = rung + 1; droppedAt = t; }
    else if (frameAvg < 1 / 57 && rung > 0 && t - droppedAt > 20) next = rung - 1;
    if (next === rung) return;
    rung = next; rungAt = t; frameAvg = 1 / 60;
    const [pr, vd] = ladder[rung];
    vegDensity = vd;
    if (pr !== PR) { PR = pr; prU.value = PR; renderer.setPixelRatio(PR); if (composer) composer.setPixelRatio(PR); resize(); }
  }

  // Compile every shader now, behind the loading screen, instead of stalling the first frames on screen (on Windows,
  // where browsers translate shaders to Direct3D, the first visit spends seconds here; the browser's shader cache makes
  // repeat visits fast). Skipping three.js's per-program error check outside development avoids extra driver round-trips.
  await step('Compiling shaders', 0.88);
  renderer.debug.checkShaderErrors = !!import.meta.env.DEV;
  renderer.compile(scene, camera);
  await step('First light', 0.97);
  tick();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // the first frames (and their shadow shaders) are done
  onProgress(1, 'Ready');
  buildLog.push([buildLabel + ' + first frames', Math.round(performance.now() - buildT)]);

  return {
    buildLog,
    setAuto, setLamp, setFollow, moonView,
    // toggles read the engine's own state, so they can't act on a stale copy in React
    toggleAuto: () => setAuto(!state.auto),
    toggleLamp: () => setLamp(!state.lamp),
    toggleFollow: () => setFollow(!state.follow),
    setRain: v => rain.setAmount(v),
    toggleSit: () => toggleSit(false),
    setGlow: v => { state.glow = v; },
    setMoonGain: v => { state.moonGain = v; },
    setClouds: v => { skyUniforms.uCloud.value = v; },
    dispose() {
      disposed = true;
      cancelAnimationFrame(rafId);
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
      controls.dispose();
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); }
      });
      if (composer) composer.dispose ? composer.dispose() : null;
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
  };
  }


  return start();
}
