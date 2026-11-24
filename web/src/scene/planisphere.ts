import * as THREE from "three";
import { SpringBank, horizonOutline, lathe, radialTransforms, windowCover, type Mesh } from "../wasm";
import { MONTHS_SHORT } from "../strings.da";
import { ENAMEL, GOLD_PRINT, INK, PlanarCanvas, SERIF_FONT, brass, enamel } from "./materials";

/** Star-wheel radius per unit of plate coordinates (Rust `Sky::plate`). */
export const PLATE_SCALE = 0.97;
/** Stars sit just above the wheel surface. */
export const STAR_Y = 0.0065;
/** Before unlocking, the generic plate uses Denmark's latitude (no personal data). */
export const DEFAULT_LAT = 55.7;

const WHEEL_R = 1.06;
const COVER_R = 0.94;
const COVER_Y = 0.03;
const HINGE = new THREE.Vector3(0, 0.062, -1.262);
const TICKS = 24;
const PLATE_FILL = 0.92;
const DEG = Math.PI / 180;

enum Ch {
  Wheel,
  Hinge,
  Twist,
  Glow,
}

function toGeometry(m: Mesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions(), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.normals(), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(m.uvs(), 2));
  g.setIndex(new THREE.BufferAttribute(m.indices(), 1));
  m.free();
  return g;
}

const P = (...pts: number[]) => new Float32Array(pts);

/**
 * The brass planisphere: a case with an engraved hour bezel, an enamel star wheel that turns,
 * a cover with the horizon window, and a hinged lid whose 24 studs light up as she types.
 */
export class Planisphere {
  readonly group = new THREE.Group();
  /** Turns. The stars are attached here while they sit on the plate. */
  readonly wheel = new THREE.Group();
  private lidPivot = new THREE.Group();
  private cover: THREE.Mesh;
  private ticks: THREE.InstancedMesh;
  private springs = new SpringBank(4, 60, 1);
  private engraving = new PlanarCanvas(2048);
  private wheelPrint = new PlanarCanvas(2048);
  private lidArt = new PlanarCanvas(1024);
  private brassMain: THREE.MeshPhysicalMaterial;
  private typed = 0;
  private mode: "idle" | "deriving" | "rejected" | "open" = "idle";
  private rejectedAt = 0;
  private time = 0;
  private hemi = 1;
  private reduced: boolean;
  private color = new THREE.Color();

  constructor(reducedMotion: boolean) {
    this.reduced = reducedMotion;
    this.brassMain = brass(this.engraving.texture);
    const lidMat = brass(this.lidArt.texture);

    // Case: recess floor → inner wall → chamfer → bezel → outer chamfer → wall → foot → bottom.
    const caseGeo = toGeometry(
      lathe(P(0, 0, 1.07, 0, 1.07, 0.03, 1.09, 0.05, 1.22, 0.05, 1.25, 0.035, 1.25, -0.04, 1.225, -0.07, 0, -0.07), 192),
    );
    const caseMesh = new THREE.Mesh(caseGeo, this.brassMain);

    const wheelGeo = toGeometry(lathe(P(0, 0.004, WHEEL_R, 0.004, WHEEL_R, 0.0), 192));
    const wheelMesh = new THREE.Mesh(wheelGeo, enamel(this.wheelPrint.texture));
    const rivet = new THREE.Mesh(
      toGeometry(lathe(P(0, 0.026, 0.018, 0.0245, 0.03, 0.019, 0.036, 0.01, 0.036, 0.004), 48)),
      this.brassMain,
    );
    this.wheel.add(wheelMesh, rivet);

    this.cover = new THREE.Mesh(new THREE.BufferGeometry(), this.brassMain);

    // Hinge barrel on the case, plus a small clasp on the lid's front edge.
    const plain = brass();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.36, 32), plain);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.copy(HINGE);

    // Lid, a gentle dome, built in closed position and hinged at the back (north).
    const lidMesh = new THREE.Mesh(
      toGeometry(
        lathe(P(0, 0.128, 0.5, 0.123, 0.9, 0.11, 1.15, 0.093, 1.235, 0.081, 1.262, 0.066, 1.262, 0.058, 1.24, 0.053, 0, 0.053), 192),
      ),
      lidMat,
    );
    const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.034, 0.04), plain);
    clasp.position.set(0, 0.07, 1.272);

    // The 24 studs that count the typed characters (length only, never content).
    this.ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: true }), TICKS);
    const scales = new Float32Array(TICKS * 3).map((_, i) => [0.02, 0.005, 0.07][i % 3]);
    const mats = radialTransforms(TICKS, 1.11, 0.0965, Math.PI / TICKS, scales);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < TICKS; i++) {
      this.ticks.setMatrixAt(i, m4.fromArray(mats, i * 16));
      this.ticks.setColorAt(i, this.color.setRGB(0.05, 0.035, 0.02));
    }

    const lidBody = new THREE.Group();
    lidBody.add(lidMesh, clasp, this.ticks);
    lidBody.position.copy(HINGE).negate();
    this.lidPivot.position.copy(HINGE);
    this.lidPivot.add(lidBody);

    this.group.add(caseMesh, this.wheel, this.cover, barrel, this.lidPivot);
    for (const o of [caseMesh, wheelMesh, this.cover, lidMesh]) o.receiveShadow = o.castShadow = false;

    this.springs.tune(Ch.Wheel, 9, 0.9);
    this.springs.tune(Ch.Hinge, 16, 0.55);
    this.springs.tune(Ch.Twist, 260, 0.22);
    this.springs.tune(Ch.Glow, 40, 1);
    this.drawLid();
    this.setLatitude(DEFAULT_LAT);
  }

  /** Rebuild everything that depends on latitude: window shape, graticule, labels. */
  setLatitude(lat: number): void {
    this.hemi = lat < 0 ? -1 : 1;
    this.cover.geometry.dispose();
    this.cover.geometry = toGeometry(windowCover(horizonOutline(lat, 256).map((v) => v * PLATE_SCALE), COVER_R, COVER_Y, 0.026));
    this.drawEngraving(lat);
    this.drawWheel(lat);
  }

  /** Light one stud per typed character (wraps after 24). */
  setTyped(n: number): void {
    this.typed = n;
    if (this.mode === "rejected") this.mode = "idle";
  }

  setDeriving(on: boolean): void {
    this.mode = on ? "deriving" : "idle";
  }

  /** Wrong key: the lid shudders and the studs fade out. */
  reject(): void {
    this.mode = "rejected";
    this.rejectedAt = this.time;
    this.typed = 0;
    this.springs.kick(Ch.Twist, this.reduced ? 0 : -1.1);
  }

  /** Turn the star wheel to the moment: `lst` in radians. Adds one extra turn so the motion reads as deliberate. */
  turnTo(lst: number): void {
    const a = this.springs.get(Ch.Wheel);
    let target = -this.hemi * lst;
    const turn = Math.PI * 2;
    while (target > a - Math.PI * 1.2) target -= turn;
    while (target < a - Math.PI * 3.2) target += turn;
    if (this.reduced) this.springs.set(Ch.Wheel, target);
    else this.springs.setTarget(Ch.Wheel, target);
  }

  get wheelSettled(): boolean {
    return Math.abs(this.springs.get(Ch.Wheel) - this.springs.target(Ch.Wheel)) < 0.002;
  }

  openLid(): void {
    this.mode = "open";
    if (this.reduced) this.springs.set(Ch.Hinge, -1.95);
    else this.springs.setTarget(Ch.Hinge, -1.95);
  }

  update(dt: number, t: number): void {
    this.time = t;
    const s = this.springs;
    if (this.mode !== "open") {
      // Idle drift of the hidden wheel; quicker while the key is being derived.
      const drift = this.mode === "deriving" ? 0.5 : 0.04;
      s.setTarget(Ch.Wheel, s.target(Ch.Wheel) - drift * dt);
      // A slight lift of the lid while deriving, as if something is trying to open it.
      s.setTarget(Ch.Hinge, this.mode === "deriving" && !this.reduced ? -0.025 : 0);
    }
    s.step(dt);
    this.wheel.rotation.y = s.get(Ch.Wheel);
    this.lidPivot.rotation.x = s.get(Ch.Hinge);
    this.lidPivot.rotation.y = s.get(Ch.Twist) * 0.06;
    this.updateTicks(t);
  }

  private updateTicks(t: number): void {
    const lit = Math.min(this.typed, TICKS);
    const fade = this.mode === "rejected" ? Math.max(0, 1 - (t - this.rejectedAt) / 0.9) : 1;
    for (let i = 0; i < TICKS; i++) {
      let e = 0;
      if (this.mode === "deriving") {
        // A light chasing around the rim.
        const phase = (((t * 1.6 - i / TICKS) % 1) + 1) % 1;
        e = 0.25 + 0.9 * Math.pow(1 - phase, 6);
      } else if (this.mode === "rejected") {
        e = 0.9 * fade * (0.5 + 0.5 * Math.sin(t * 40));
      } else if (this.mode === "open") {
        e = 0.4;
      } else if (i < lit || (this.typed > TICKS && i < this.typed % TICKS)) {
        e = 1;
      }
      const off = [0.05, 0.035, 0.02];
      const on = this.mode === "rejected" ? [1.8, 0.55, 0.35] : [2.2, 1.55, 0.8];
      this.color.setRGB(off[0] + (on[0] - off[0]) * e, off[1] + (on[1] - off[1]) * e, off[2] + (on[2] - off[2]) * e);
      this.ticks.setColorAt(i, this.color);
    }
    this.ticks.instanceColor!.needsUpdate = true;
  }

  /** Plate radius (world) of a star at polar distance p from the visible pole. */
  private plateR(p: number, phiAbs: number): number {
    return (PLATE_SCALE * PLATE_FILL * p) / (Math.PI - phiAbs);
  }

  /** Case bezel (hour ring) and cover (cardinal points), both engraved and lacquer-filled. */
  private drawEngraving(lat: number): void {
    const p = this.engraving;
    const c = p.ctx;
    c.fillStyle = "#fff";
    c.fillRect(0, 0, p.size, p.size);
    const h = this.hemi;

    // Hour ring on the bezel: midnight towards the meridian (+z north of the equator).
    for (let q = 0; q < 96; q++) {
      const psi = -h * q * 3.75 * DEG + (h < 0 ? Math.PI : 0);
      const major = q % 4 === 0;
      p.radial(psi, 1.078, major ? 1.112 : q % 2 === 0 ? 1.098 : 1.09, major ? 0.004 : 0.0022, INK);
      if (major) {
        const hour = q / 4;
        p.label(String(hour === 0 ? 24 : hour), 1.152, psi, 0.034, INK, SERIF_FONT, 500, 0.02);
      }
    }
    p.circle(1.2, 0.0025, INK);
    p.circle(1.212, 0.0012, INK);

    // Cardinal points just outside the window edge.
    const phi = Math.abs(lat) * DEG;
    const south = this.plateR(Math.PI - phi, phi);
    const north = this.plateR(phi, phi);
    const ew = this.plateR(Math.PI / 2, phi);
    const marks: [string, number, number][] = [
      [h > 0 ? "SYD" : "NORD", Math.min(south + 0.022, COVER_R - 0.018), 0],
      [h > 0 ? "NORD" : "SYD", north + 0.05, Math.PI],
      ["ØST", ew + 0.05, Math.PI / 2],
      ["VEST", ew + 0.05, -Math.PI / 2],
    ];
    for (const [text, r, psi] of marks) p.label(text, r, psi, 0.026, INK, undefined, 600, 0.3);
    p.circle(COVER_R - 0.006, 0.002, INK);
    p.update();
  }

  /** The enamel wheel: graticule, ecliptic and the date ring, in the wheel's own (LST = 0) frame. */
  private drawWheel(lat: number): void {
    const p = this.wheelPrint;
    const c = p.ctx;
    const h = this.hemi;
    const phi = Math.abs(lat) * DEG;
    c.fillStyle = ENAMEL;
    c.fillRect(0, 0, p.size, p.size);
    // Map RA α (rad) and polar distance to wheel coordinates (matches Rust plate(lst = 0)).
    const at = (alpha: number, pd: number): [number, number] => {
      const r = this.plateR(pd, phi);
      return p.px(r * Math.sin(alpha), h * r * Math.cos(alpha));
    };

    c.globalAlpha = 0.16;
    for (let dec = 60; dec >= -60; dec -= 30) {
      const pd = Math.PI / 2 - h * dec * DEG;
      if (this.plateR(pd, phi) > 0.94) continue;
      p.circle(this.plateR(pd, phi), dec === 0 ? 0.0024 : 0.0014, GOLD_PRINT);
    }
    for (let hr = 0; hr < 24; hr += 2) {
      const a = hr * 15 * DEG;
      c.beginPath();
      c.moveTo(...at(a, 10 * DEG));
      c.lineTo(...at(a, Math.min(Math.PI - phi, Math.PI * 0.75)));
      c.lineWidth = 0.0012 * p.k;
      c.strokeStyle = GOLD_PRINT;
      c.stroke();
    }
    // Ecliptic, dotted.
    c.globalAlpha = 0.32;
    c.fillStyle = GOLD_PRINT;
    const eps = 23.44 * DEG;
    for (let i = 0; i < 180; i++) {
      const lam = (i / 180) * Math.PI * 2;
      const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
      const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
      const [x, y] = at(ra, Math.PI / 2 - h * dec);
      c.beginPath();
      c.arc(x, y, 0.0022 * p.k, 0, Math.PI * 2);
      c.fill();
    }

    // Date ring: the date sits at the RA on the meridian at local midnight.
    c.globalAlpha = 1;
    const ringIn = 0.955;
    p.circle(ringIn, 0.0016, GOLD_PRINT);
    p.circle(1.045, 0.0016, GOLD_PRINT);
    const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const raOfDay = (doy: number) => (100.46 + 0.985647 * doy) * DEG;
    const psiOf = (alpha: number) => (h > 0 ? alpha : Math.PI - alpha);
    let doy = 0;
    for (let m = 0; m < 12; m++) {
      for (let d = 0; d < days[m]; d++, doy++) {
        const len = d === 0 ? 0.05 : d % 5 === 0 ? 0.022 : 0.012;
        p.radial(psiOf(raOfDay(doy)), 1.045 - len, 1.045, d === 0 ? 0.003 : 0.0016, GOLD_PRINT);
      }
      p.label(MONTHS_SHORT[m], 0.982, psiOf(raOfDay(doy - days[m] / 2)), 0.024, GOLD_PRINT, undefined, 600, 0.28);
    }
    p.update();
  }

  /** Lid emblem: a fine compass star in rings, and the name of the thing. */
  private drawLid(): void {
    const p = this.lidArt;
    const c = p.ctx;
    c.fillStyle = "#fff";
    c.fillRect(0, 0, p.size, p.size);
    p.circle(1.2, 0.004, INK);
    p.circle(1.185, 0.0015, INK);
    p.circle(1.06, 0.0015, INK);
    p.circle(0.46, 0.003, INK);
    p.circle(0.44, 0.0012, INK);
    // 8-point star: long cardinal rays, short diagonals.
    const [cx, cy] = p.px(0, 0);
    c.save();
    c.translate(cx, cy);
    for (let i = 0; i < 8; i++) {
      const long = i % 2 === 0;
      const r = (long ? 0.4 : 0.22) * p.k;
      const w = (long ? 0.05 : 0.04) * p.k;
      c.save();
      c.rotate((i * Math.PI) / 4);
      c.beginPath();
      c.moveTo(0, -r);
      c.lineTo(w, 0);
      c.lineTo(0, 0);
      c.closePath();
      c.fillStyle = INK;
      c.fill();
      c.beginPath();
      c.moveTo(0, -r);
      c.lineTo(-w, 0);
      c.lineTo(0, 0);
      c.closePath();
      c.lineWidth = 0.002 * p.k;
      c.strokeStyle = INK;
      c.stroke();
      c.restore();
    }
    c.restore();
    for (let i = 0; i < 72; i++) p.radial((i / 72) * Math.PI * 2, 0.62, i % 6 === 0 ? 0.66 : 0.64, 0.0018, INK);
    p.circle(0.62, 0.0015, INK);
    p.label("STJERNEHIMLEN", 0.8, 0, 0.042, INK, SERIF_FONT, 420, 0.32);
    p.label("✦", 0.8, Math.PI, 0.05, INK, SERIF_FONT, 400, 0);
    p.update();
  }
}
