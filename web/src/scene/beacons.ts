import * as THREE from "three";
import type { HerStar } from "../manifest";
import { fromAltAz } from "./constellation";
import { DOME_R } from "./stars";

const DEG = Math.PI / 180;

/** What a beacon is. Drawn differently, picked the same way. */
export const enum Kind {
  Her = 0,
  DoorReady = 1, // its day has come and she hasn't opened it
  DoorOpened = 2,
  DoorWaiting = 3, // not yet
}

export interface NearStar {
  i: number;
  n: string;
  d: number;
}

export interface HerStarPick {
  index: number;
  name: string;
  ly: number;
  dir: THREE.Vector3;
  leftYear: number;
}

/**
 * Her star: a real star, high enough in your sky, whose light left it around the year she was born.
 * Light that reaches her today left the star (distance in light-years) years ago.
 */
export function pickHerStar(her: HerStar, near: NearStar[], dome: Float32Array, mags: Float32Array): HerStarPick | null {
  const now = new Date();
  const year = now.getFullYear() + now.getMonth() / 12;
  const dir = (i: number) => new THREE.Vector3(dome[i * 3], dome[i * 3 + 1], dome[i * 3 + 2]);
  const make = (s: NearStar): HerStarPick => ({ index: s.i, name: s.n, ly: s.d, dir: dir(s.i), leftYear: Math.round(year - s.d) });

  if (her.star) {
    const want = her.star.trim().toLowerCase();
    const s = near.find((x) => x.n.toLowerCase() === want);
    if (s) return make(s);
    console.warn(`her_star.star "${her.star}" isn't among the named nearby stars; choosing one instead`);
  }
  const minAlt = Math.sin(12 * DEG);
  let best: NearStar | null = null;
  let bestScore = Infinity;
  for (const s of near) {
    if (dome[s.i * 3 + 1] < minAlt) continue; // below or too close to the horizon that night
    const yearsOff = Math.abs(year - s.d - her.born);
    // Close to her birth year first; among similar ones, brighter and properly named win.
    const score = yearsOff + 0.35 * Math.max(0, mags[s.i]) + (/^[A-Z][a-z]/.test(s.n) ? 0 : 0.8);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best ? make(best) : null;
}

/**
 * The advent calendar as a Christmas tree in the sky: rows of 1–6 stars and a trunk of 3 (24 in
 * all). Door 24 is the star on top; the other days are scattered over the tree, like a real
 * calendar's doors. The same days always give the same tree. `outline` lists pairs of days to join
 * with a faint line (the tree's edges and trunk).
 */
export function treeLayout(days: number[], facingAz: number, avoidAz: number[]): { pos: Map<number, THREE.Vector3>; outline: [number, number][] } {
  const spots: [number, number][] = [];
  for (let row = 0; row < 6; row++) {
    for (let k = 0; k <= row; k++) spots.push([(k - row / 2) * 2.9, -row * 2.6]);
  }
  for (let k = 1; k <= 3; k++) spots.push([0, -13 - k * 2.3]); // trunk, just under the bottom row
  // Beside the memories: east of them, or west if that side is clearer.
  const az0 = [facingAz - 72, facingAz + 72].sort((a, b) => minDist(b, avoidAz) - minDist(a, avoidAz))[0];
  const top = 46;

  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 24).sort((a, b) => a - b);
  const topDay = sorted.includes(24) ? 24 : sorted[sorted.length - 1];
  const rest = sorted.filter((d) => d !== topDay);
  // Deterministic shuffle of the other 23 spots.
  const order = spots
    .slice(1)
    .map((_, i) => ({ spot: i + 1, k: (((Math.sin((i + 1) * 91.17) * 43758.5453) % 1) + 1) % 1 }))
    .sort((a, b) => a.k - b.k)
    .map((o) => o.spot);
  const daySpot = new Map<number, number>([[topDay, 0]]);
  rest.forEach((d, i) => daySpot.set(d, order[i]));

  const pos = new Map<number, THREE.Vector3>();
  for (const [day, spot] of daySpot) {
    const [x, y] = spots[spot];
    const alt = top + y;
    pos.set(day, fromAltAz(alt, az0 + x / Math.cos(alt * DEG)));
  }
  // Edges: top → both ends of the bottom row, along the bottom row, and down the trunk.
  const spotDay = new Map([...daySpot].map(([d, s]) => [s, d]));
  const outline: [number, number][] = [];
  const join = (a: number, b: number) => {
    const da = spotDay.get(a);
    const db = spotDay.get(b);
    if (da !== undefined && db !== undefined) outline.push([da, db]);
  };
  const rowStart = (r: number) => (r * (r + 1)) / 2;
  for (let r = 0; r < 5; r++) {
    join(rowStart(r), rowStart(r + 1)); // left edge
    join(rowStart(r) + r, rowStart(r + 1) + r + 1); // right edge
  }
  join(rowStart(5), rowStart(5) + 5); // bottom
  join(21, 22);
  join(22, 23);
  return { pos, outline };
}

function minDist(az: number, others: number[]): number {
  return Math.min(180, ...others.map((o) => Math.abs(((((az - o) % 360) + 540) % 360) - 180)));
}

const vertex = /* glsl */ `
  attribute float aKind;
  attribute float aIdx;
  uniform float uPixelRatio;
  uniform float uZoom;
  uniform float uTime;
  uniform float uReveal;
  uniform float uHover;
  varying float vKind;
  varying float vAlpha;
  varying float vHot;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    float hot = float(abs(uHover - aIdx) < 0.5);
    float pulse = aKind < 1.5 ? 1.0 + 0.12 * sin(uTime * 2.2 + aIdx) : 1.0;
    float size = aKind < 0.5 ? 44.0 : aKind < 1.5 ? 38.0 : aKind < 2.5 ? 26.0 : 18.0;
    gl_PointSize = size * pulse * (1.0 + 0.25 * hot) * uZoom * uPixelRatio;
    vKind = aKind;
    vHot = hot;
    vAlpha = uReveal * (aKind > 2.5 ? 0.55 : 1.0);
  }
`;

const fragment = /* glsl */ `
  varying float vKind;
  varying float vAlpha;
  varying float vHot;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;
    vec3 col = vKind < 0.5 ? vec3(1.0, 0.74, 0.8)     // her star: rose gold
             : vKind < 1.5 ? vec3(1.0, 0.83, 0.52)    // a door that's ready
             : vKind < 2.5 ? vec3(0.96, 0.87, 0.68)   // opened
             : vec3(0.78, 0.84, 1.0);                 // waiting
    float core = exp(-r * r * 30.0) * 2.2;
    float glow = exp(-r * r * 5.0) * (vKind < 1.5 ? 0.6 : 0.4) * (1.0 + 0.6 * vHot);
    float spikes = vKind < 1.5 ? (exp(-abs(c.x) * 38.0) * exp(-abs(c.y) * 3.2) + exp(-abs(c.y) * 38.0) * exp(-abs(c.x) * 3.2)) * 0.45 : 0.0;
    float ring = vKind < 0.5 ? exp(-pow((r - 0.62) * 14.0, 2.0)) * 0.35 : 0.0;
    gl_FragColor = vec4(col, (core + glow + spikes + ring) * vAlpha * (1.0 - smoothstep(0.85, 1.0, r)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Her star and the advent doors: drawn as one Points object, picked by screen distance. */
export class Beacons {
  readonly group = new THREE.Group();
  private dirs: THREE.Vector3[] = [];
  private kinds: number[] = [];
  private material: THREE.ShaderMaterial;
  private points: THREE.Points | null = null;
  private outline: THREE.LineSegments | null = null;
  private screen = new THREE.Vector3();
  private labels: { i: number; el: HTMLElement }[] = [];

  constructor(private ui: HTMLElement) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
        uZoom: { value: 1 },
        uTime: { value: 0 },
        uReveal: { value: 0 },
        uHover: { value: -1 },
      },
    });
    this.group.visible = false;
  }

  /** Add a beacon; returns its index. */
  add(dir: THREE.Vector3, kind: Kind): number {
    this.dirs.push(dir.clone().normalize());
    this.kinds.push(kind);
    return this.dirs.length - 1;
  }

  setKind(i: number, kind: Kind): void {
    this.kinds[i] = kind;
    if (this.points) {
      const a = this.points.geometry.getAttribute("aKind") as THREE.BufferAttribute;
      a.array[i] = kind;
      a.needsUpdate = true;
    }
  }

  kind(i: number): Kind {
    return this.kinds[i];
  }

  dir(i: number): THREE.Vector3 {
    return this.dirs[i];
  }

  /** A small name under a beacon (her star). */
  label(i: number, text: string): void {
    const el = document.createElement("p");
    el.className = "beacon-label";
    el.textContent = text;
    this.ui.append(el);
    this.labels.push({ i, el });
  }

  /** A faint line drawing through the given beacons, in order (the tree's outline). */
  drawLines(pairs: [number, number][]): void {
    const pos: number[] = [];
    for (const [a, b] of pairs) {
      pos.push(...this.dirs[a].clone().multiplyScalar(DOME_R * 0.985).toArray(), ...this.dirs[b].clone().multiplyScalar(DOME_R * 0.985).toArray());
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    this.outline = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: new THREE.Color(0.95, 0.82, 0.55), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.outline.frustumCulled = false;
    this.group.add(this.outline);
  }

  /** Build the GPU object once every beacon is added. */
  build(): void {
    const n = this.dirs.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.dirs.flatMap((d) => d.clone().multiplyScalar(DOME_R * 0.99).toArray())), 3));
    g.setAttribute("aKind", new THREE.BufferAttribute(new Float32Array(this.kinds), 1));
    g.setAttribute("aIdx", new THREE.BufferAttribute(new Float32Array(n).map((_, i) => i), 1));
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.group.add(this.points);
  }

  set reveal(v: number) {
    this.group.visible = v > 0;
    this.material.uniforms.uReveal.value = v;
    if (this.outline) (this.outline.material as THREE.LineBasicMaterial).opacity = 0.18 * v;
    for (const l of this.labels) l.el.classList.toggle("is-shown", v > 0.6);
  }

  setHover(i: number): void {
    this.material.uniforms.uHover.value = i;
  }

  update(t: number, zoom: number, camera: THREE.Camera): void {
    this.material.uniforms.uTime.value = t;
    this.material.uniforms.uZoom.value = zoom;
    for (const { i, el } of this.labels) {
      const s = this.screenOf(i, camera);
      el.style.setProperty("--x", `${s.x}px`);
      el.style.setProperty("--y", `${s.y}px`);
      el.classList.toggle("is-off", !s.visible);
    }
  }

  /** Index of the beacon nearest the pointer (CSS px), or −1. */
  pick(x: number, y: number, camera: THREE.Camera, radius = 30): number {
    let best = -1;
    let bestD = radius;
    for (let i = 0; i < this.dirs.length; i++) {
      const s = this.screenOf(i, camera);
      if (!s.visible) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private screenOf(i: number, camera: THREE.Camera): { x: number; y: number; visible: boolean } {
    this.screen.copy(this.dirs[i]).multiplyScalar(DOME_R).project(camera);
    return {
      x: (this.screen.x * 0.5 + 0.5) * innerWidth,
      y: (-this.screen.y * 0.5 + 0.5) * innerHeight,
      visible: this.screen.z < 1 && Math.abs(this.screen.x) < 1.05 && Math.abs(this.screen.y) < 1.05,
    };
  }
}
