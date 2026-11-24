import * as THREE from "three";
import type { Memory } from "../manifest";
import { DOME_R } from "./stars";

const DEG = Math.PI / 180;

/** Dome unit vector from altitude/azimuth in degrees (north = −z, east = +x). */
export function fromAltAz(alt: number, az: number): THREE.Vector3 {
  const a = alt * DEG;
  const z = az * DEG;
  return new THREE.Vector3(Math.cos(a) * Math.sin(z), Math.sin(a), -Math.cos(a) * Math.cos(z));
}

/**
 * Where the memory stars hang: their own alt/az if given, otherwise an arc across the sky
 * facing away from the visible pole, rising towards the middle. The letter star sits above the arc.
 */
export function placeStars(memories: Memory[], lat: number, avoid: THREE.Vector3[] = [], narrow = 1): THREE.Vector3[] {
  const n = memories.length;
  const facing = lat >= 0 ? 180 : 0;
  const spread = Math.min(42, 8 + 9 * n) * narrow; // narrower on portrait screens, so it fits the first view
  const out = memories.map((m, i) => {
    if (m.alt != null && m.az != null) return fromAltAz(m.alt, m.az);
    const t = n === 1 ? 0.5 : i / (n - 1);
    const jitter = Math.sin(i * 12.9898) * 43758.5453;
    const j = jitter - Math.floor(jitter) - 0.5;
    return fromAltAz(24 + 16 * Math.sin(Math.PI * t) + j * 6, facing - spread + 2 * spread * t + j * 3);
  });
  const top = Math.max(30, ...out.map((v) => Math.asin(v.y) / DEG));
  out.push(fromAltAz(Math.min(top + 13, 72), facing + 3));
  // Keep clear of bright real stars (only auto-placed ones move), so neither is mistaken for the other.
  const minAngle = 3.2 * DEG;
  out.forEach((v, i) => {
    if (i < n && memories[i].alt != null) return;
    for (let k = 0; k < 8; k++) {
      const hit = avoid.find((a) => a.angleTo(v) < minAngle);
      if (!hit) break;
      const away = v.clone().sub(hit).normalize();
      v.addScaledVector(away, minAngle * 0.6).normalize();
    }
  });
  return out;
}

const starVertex = /* glsl */ `
  attribute float aKind;
  attribute float aIdx;
  attribute float aVisited;
  uniform float uPixelRatio;
  uniform float uZoom;
  uniform float uTime;
  uniform float uReveal;
  uniform float uHover;
  uniform float uFocus;
  varying float vKind;
  varying float vVisited;
  varying float vAlpha;
  varying float vHot;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    float appear = smoothstep(aIdx * 0.22, aIdx * 0.22 + 0.7, uReveal);
    float hot = max(float(abs(uHover - aIdx) < 0.5), float(abs(uFocus - aIdx) < 0.5));
    float pulse = 1.0 + 0.07 * sin(uTime * 1.3 + aIdx * 2.1);
    float size = mix(36.0, 48.0, aKind) * pulse * (1.0 + 0.25 * hot) * mix(0.6, 1.0, appear);
    gl_PointSize = size * uZoom * uPixelRatio;
    vKind = aKind;
    vVisited = aVisited;
    vAlpha = appear;
    vHot = hot;
  }
`;

const starFragment = /* glsl */ `
  varying float vKind;
  varying float vVisited;
  varying float vAlpha;
  varying float vHot;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;
    float core = exp(-r * r * 36.0) * 2.2;
    float glow = exp(-r * r * 6.0) * (0.45 + 0.3 * vHot);
    float spikes = (exp(-abs(c.x) * 40.0) * exp(-abs(c.y) * 3.4) + exp(-abs(c.y) * 40.0) * exp(-abs(c.x) * 3.4)) * 0.4;
    // An unvisited memory wears a faint ring.
    float ring = exp(-pow((r - 0.6) * 16.0, 2.0)) * 0.3 * (1.0 - vVisited) * (1.0 - vKind);
    vec3 col = mix(vec3(1.0, 0.86, 0.62), vec3(1.0, 0.78, 0.72), vKind);
    float a = (core + glow + spikes + ring) * vAlpha * (1.0 - smoothstep(0.85, 1.0, r));
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const lineVertex = /* glsl */ `
  attribute float aT;
  attribute float aSide;
  attribute float aGap;
  varying float vT;
  varying float vSide;
  varying float vGap;
  void main() {
    vT = aT; vSide = aSide; vGap = aGap;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const lineFragment = /* glsl */ `
  uniform float uProgress;
  varying float vT;
  varying float vSide;
  varying float vGap;
  void main() {
    float head = smoothstep(uProgress, uProgress - 0.015, vT);
    float edge = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
    float gap = smoothstep(1.0, 2.0, vGap);
    gl_FragColor = vec4(vec3(0.98, 0.84, 0.6), 0.55 * head * edge * gap);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** The memory stars, the letter star and the lines that join them. */
export class Constellation {
  readonly group = new THREE.Group();
  readonly dirs: THREE.Vector3[];
  readonly letterIndex: number;
  private starMat: THREE.ShaderMaterial;
  private lineMat: THREE.ShaderMaterial;
  private visited: THREE.BufferAttribute;
  private screen = new THREE.Vector3();

  constructor(memories: Memory[], lat: number, avoid: THREE.Vector3[] = [], narrow = 1) {
    this.dirs = placeStars(memories, lat, avoid, narrow);
    this.letterIndex = this.dirs.length - 1;
    const n = this.dirs.length;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.dirs.flatMap((d) => d.clone().multiplyScalar(DOME_R * 0.995).toArray())), 3));
    g.setAttribute("aKind", new THREE.BufferAttribute(new Float32Array(n).map((_, i) => (i === n - 1 ? 1 : 0)), 1));
    g.setAttribute("aIdx", new THREE.BufferAttribute(new Float32Array(n).map((_, i) => i), 1));
    this.visited = new THREE.BufferAttribute(new Float32Array(n), 1);
    g.setAttribute("aVisited", this.visited);
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
        uZoom: { value: 1 },
        uTime: { value: 0 },
        uReveal: { value: 0 },
        uHover: { value: -1 },
        uFocus: { value: -1 },
      },
    });
    const stars = new THREE.Points(g, this.starMat);
    stars.frustumCulled = false;
    stars.renderOrder = 4;

    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: lineVertex,
      fragmentShader: lineFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uProgress: { value: 0 } },
    });
    const lines = new THREE.Mesh(this.ribbons(), this.lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 3;

    this.group.add(lines, stars);
    this.group.visible = false;
  }

  /** Great-circle ribbons through the stars in order. aT runs 0→1 along the whole path, so one uniform draws it in. */
  private ribbons(): THREE.BufferGeometry {
    const R = DOME_R * 0.99;
    const W = 0.07;
    const STEPS = 40;
    const pos: number[] = [];
    const t: number[] = [];
    const side: number[] = [];
    const gap: number[] = [];
    const idx: number[] = [];
    const lens = this.dirs.slice(1).map((d, i) => d.angleTo(this.dirs[i]));
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let k = 0; k < lens.length; k++) {
      const a = this.dirs[k];
      const b = this.dirs[k + 1];
      for (let i = 0; i <= STEPS; i++) {
        const u = i / STEPS;
        slerp(a, b, u, p);
        slerp(a, b, Math.min(1, u + 0.01), q);
        if (u + 0.01 > 1) slerp(a, b, u - 0.01, q).sub(p).negate().add(p);
        s.copy(q).sub(p).cross(p).normalize().multiplyScalar(W);
        const base = pos.length / 3;
        for (const sign of [-1, 1]) {
          pos.push(p.x * R + s.x * sign, p.y * R + s.y * sign, p.z * R + s.z * sign);
          t.push((acc + lens[k] * u) / total);
          side.push(sign);
          gap.push(Math.min(u, 1 - u) * lens[k] * R);
        }
        if (i < STEPS) idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
      acc += lens[k];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aT", new THREE.Float32BufferAttribute(t, 1));
    g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute("aGap", new THREE.Float32BufferAttribute(gap, 1));
    g.setIndex(idx);
    return g;
  }

  set reveal(v: number) {
    this.group.visible = v > 0;
    this.starMat.uniforms.uReveal.value = v * (this.dirs.length * 0.22 + 0.7);
  }

  set progress(v: number) {
    this.lineMat.uniforms.uProgress.value = v * 1.02;
  }

  setHover(i: number): void {
    this.starMat.uniforms.uHover.value = i;
  }

  setFocus(i: number): void {
    this.starMat.uniforms.uFocus.value = i;
  }

  markVisited(i: number): void {
    this.visited.array[i] = 1;
    this.visited.needsUpdate = true;
  }

  update(t: number, zoom: number): void {
    this.starMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uZoom.value = zoom;
  }

  /** Index of the star nearest the pointer (CSS px), or −1. */
  pick(x: number, y: number, camera: THREE.Camera, radius = 34): number {
    let best = -1;
    let bestD = radius;
    for (let i = 0; i < this.dirs.length; i++) {
      this.screen.copy(this.dirs[i]).multiplyScalar(DOME_R).project(camera);
      if (this.screen.z > 1) continue;
      const sx = (this.screen.x * 0.5 + 0.5) * innerWidth;
      const sy = (-this.screen.y * 0.5 + 0.5) * innerHeight;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Screen position (CSS px) of star i. */
  screenOf(i: number, camera: THREE.Camera): { x: number; y: number; visible: boolean } {
    this.screen.copy(this.dirs[i]).multiplyScalar(DOME_R).project(camera);
    return {
      x: (this.screen.x * 0.5 + 0.5) * innerWidth,
      y: (-this.screen.y * 0.5 + 0.5) * innerHeight,
      visible: this.screen.z < 1 && Math.abs(this.screen.x) < 1 && Math.abs(this.screen.y) < 1,
    };
  }
}

function slerp(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const w = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
  if (w < 1e-6) return out.copy(a);
  const s = Math.sin(w);
  return out
    .copy(a)
    .multiplyScalar(Math.sin((1 - t) * w) / s)
    .addScaledVector(b, Math.sin(t * w) / s);
}
