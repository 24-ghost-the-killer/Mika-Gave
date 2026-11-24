import * as THREE from "three";

/** Every planisphere part uses planar UVs over this radius (see crates/gift-wasm/src/geometry.rs). */
export const UV_R = 1.4;

export const UI_FONT = '"Instrument Sans Variable", system-ui, sans-serif';
export const SERIF_FONT = '"Fraunces Variable", Georgia, serif';

/** A square canvas addressed in planisphere coordinates (x, z). +z is drawn downwards, so it matches the camera's view. */
export class PlanarCanvas {
  readonly canvas = document.createElement("canvas");
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;

  constructor(readonly size: number, color = true) {
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false;
    this.texture.anisotropy = 8;
    if (color) this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /** World units → canvas pixels. */
  get k(): number {
    return this.size / (2 * UV_R);
  }

  px(x: number, z: number): [number, number] {
    return [(x / (2 * UV_R) + 0.5) * this.size, (z / (2 * UV_R) + 0.5) * this.size];
  }

  /** Point at radius r, angle ψ (ψ = 0 → +z, towards the viewer). */
  polar(r: number, psi: number): [number, number] {
    return this.px(r * Math.sin(psi), r * Math.cos(psi));
  }

  circle(r: number, width: number, style: string): void {
    const [cx, cy] = this.px(0, 0);
    const c = this.ctx;
    c.beginPath();
    c.arc(cx, cy, r * this.k, 0, Math.PI * 2);
    c.lineWidth = width * this.k;
    c.strokeStyle = style;
    c.stroke();
  }

  radial(psi: number, r0: number, r1: number, width: number, style: string): void {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(...this.polar(r0, psi));
    c.lineTo(...this.polar(r1, psi));
    c.lineWidth = width * this.k;
    c.strokeStyle = style;
    c.lineCap = "round";
    c.stroke();
  }

  /** Text centred at (r, ψ), baseline tangent. It reads upright for a viewer at +z; labels on the far half are flipped so they never read upside-down. */
  label(text: string, r: number, psi: number, size: number, style: string, font = UI_FONT, weight = 500, spacing = 0.12): void {
    const c = this.ctx;
    const [x, y] = this.polar(r, psi);
    const far = Math.cos(psi) < -1e-6;
    c.save();
    c.translate(x, y);
    c.rotate(-psi + (far ? Math.PI : 0));
    c.font = `${weight} ${size * this.k}px ${font}`;
    c.letterSpacing = `${spacing * size * this.k}px`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = style;
    c.fillText(text, spacing * size * this.k * 0.5, 0);
    c.restore();
  }

  update(): void {
    this.texture.needsUpdate = true;
  }
}

/** Concentric brushed-metal roughness: fine turned rings, the way a lathe leaves brass. */
function brushedRoughness(): THREE.CanvasTexture {
  const p = new PlanarCanvas(1024, false);
  const c = p.ctx;
  c.fillStyle = "rgb(84,84,84)";
  c.fillRect(0, 0, p.size, p.size);
  const [cx, cy] = p.px(0, 0);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    const r = rnd() * p.size * 0.72;
    const v = 60 + rnd() * 50;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.lineWidth = 0.6 + rnd() * 1.6;
    c.strokeStyle = `rgba(${v},${v},${v},0.45)`;
    c.stroke();
  }
  p.texture.wrapS = p.texture.wrapT = THREE.ClampToEdgeWrapping;
  return p.texture;
}

let roughness: THREE.CanvasTexture | null = null;

export function brass(map?: THREE.Texture): THREE.MeshPhysicalMaterial {
  roughness ??= brushedRoughness();
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color("#d2a45c"),
    metalness: 1,
    roughness: 1.0, // multiplied by roughnessMap (≈ 0.25–0.43)
    roughnessMap: roughness,
    map: map ?? null,
    clearcoat: 0.35,
    clearcoatRoughness: 0.18,
  });
}

export function enamel(map: THREE.Texture): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map,
    metalness: 0,
    roughness: 0.5,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
}

export const INK = "rgba(58,40,22,0.92)"; // engraved and lacquer-filled
export const GOLD_PRINT = "#e2c48c";
export const ENAMEL = "#0b1530";
