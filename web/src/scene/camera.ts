import * as THREE from "three";
import { SpringBank } from "../wasm";

enum C {
  PX,
  PY,
  PZ,
  LX,
  LY,
  LZ,
  Fov,
}

// South of the planisphere: the opened lid stands up on the north side, out of the way.
export const EXPLORE_POS = new THREE.Vector3(0, 1.0, 2.7);

/**
 * Spring-driven camera. There are two modes:
 * - "object": looks at the planisphere from above, with a little pointer parallax.
 * - "sky": stands beside the planisphere and looks around the dome (drag, pinch, wheel).
 * Position, look target and fov are seven springs, so every change of mode or focus glides.
 */
export class CameraRig {
  private s = new SpringBank(7, 60, 1);
  private mode: "object" | "sky" = "object";
  private yaw = 0; // 0 → south (+z)
  private pitch = 0.5;
  private fov = 50;
  private parallax = new THREE.Vector2();
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private fov0 = 50;
  private dragged = 0;
  private look = new THREE.Vector3();
  /** Called with CSS-pixel coordinates when the user taps without dragging. */
  onTap: (x: number, y: number) => void = () => {};
  onHover: (x: number, y: number) => void = () => {};
  onInteract: () => void = () => {};
  enabled = true;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private el: HTMLElement,
    private reduced: boolean,
  ) {
    this.objectView(true);
    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.pointers.delete(e.pointerId));
    el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    addEventListener("resize", () => this.mode === "object" && this.objectView(false));
  }

  /** The planisphere framed to fit, a little above centre so the lock prompt fits beneath it. */
  objectView(snap: boolean): void {
    this.mode = "object";
    const aspect = innerWidth / innerHeight;
    const fov = 34;
    const half = Math.tan((fov * Math.PI) / 360);
    // Fit a ~2.9-wide object horizontally and ~3.6 tall (object plus room for the prompt).
    const dist = Math.max(1.6 / (half * Math.min(aspect, 1.6)), 2.1 / half);
    const elev = 1.05; // radians above the horizontal
    const target = new THREE.Vector3(0, 0, aspect < 0.8 ? 0.62 : 0.42);
    const pos = new THREE.Vector3(0, Math.sin(elev) * dist, Math.cos(elev) * dist).add(target);
    this.set(pos, target, fov, snap);
  }

  /** Hand over to the sky: slow, cinematic springs for the lift, then responsive ones. */
  skyView(yaw: number, pitch: number): void {
    this.mode = "sky";
    this.yaw = yaw;
    this.pitch = pitch;
    this.fov = innerWidth / innerHeight < 0.8 ? 72 : 50;
    const k = this.reduced ? 60 : 2.6;
    for (let i = 0; i < 7; i++) this.s.tune(i, k, 1);
    this.applySky();
    setTimeout(() => this.responsive(), this.reduced ? 0 : 4200);
  }

  private responsive(): void {
    for (let i = 0; i < 6; i++) this.s.tune(i, i < 3 ? 14 : 26, 1);
    this.s.tune(C.Fov, 18, 1);
  }

  /** Turn to look at a dome direction. `offset` (radians) moves it off centre to leave room for a card. */
  focus(dir: THREE.Vector3, offsetYaw: number, offsetPitch: number, fov?: number): void {
    this.yaw = Math.atan2(dir.x, dir.z) + offsetYaw;
    this.pitch = THREE.MathUtils.clamp(Math.asin(dir.y) + offsetPitch, -0.1, 1.45);
    if (fov) this.fov = fov;
    this.applySky();
  }

  get zoom(): number {
    return 50 / this.camera.fov;
  }

  get yawPitch(): [number, number] {
    return [this.yaw, this.pitch];
  }

  setFov(f: number): void {
    this.fov = THREE.MathUtils.clamp(f, 28, 76);
    this.applySky();
  }

  get currentFov(): number {
    return this.fov;
  }

  private applySky(): void {
    const d = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const target = d.multiplyScalar(10).add(EXPLORE_POS);
    this.set(EXPLORE_POS, target, this.fov, false);
  }

  private set(pos: THREE.Vector3, look: THREE.Vector3, fov: number, snap: boolean): void {
    const v = [pos.x, pos.y, pos.z, look.x, look.y, look.z, fov];
    v.forEach((x, i) => (snap ? this.s.set(i, x) : this.s.setTarget(i, x)));
  }

  update(dt: number): void {
    const s = this.s;
    s.step(dt);
    const px = this.mode === "object" ? this.parallax.x * 0.18 : 0;
    const pz = this.mode === "object" ? this.parallax.y * 0.12 : 0;
    this.camera.position.set(s.get(C.PX) + px, s.get(C.PY), s.get(C.PZ) + pz);
    // The look target is a spring too. If a big turn swings it through the camera, hold the last orientation.
    this.look.set(s.get(C.LX), s.get(C.LY), s.get(C.LZ));
    if (this.look.distanceTo(this.camera.position) > 0.5) this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - s.get(C.Fov)) > 1e-3) {
      this.camera.fov = s.get(C.Fov);
      this.camera.updateProjectionMatrix();
    }
  }

  // ---------- input ----------

  private down(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragged = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      this.fov0 = this.fov;
    }
  }

  private move(e: PointerEvent): void {
    if (this.mode === "object" && e.pointerType === "mouse") {
      this.parallax.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === "mouse") this.onHover(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    this.dragged += Math.abs(dx) + Math.abs(dy);
    if (!this.enabled || this.mode !== "sky") return;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch0 > 0) this.setFov((this.fov0 * this.pinch0) / d);
      return;
    }
    // Grab-the-sky: the dome follows the finger.
    const k = ((this.camera.fov * Math.PI) / 180 / innerHeight) * 1.0;
    this.yaw += dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, -0.12, 1.45);
    this.applySky();
    if (this.dragged > 6) this.onInteract();
  }

  private up(e: PointerEvent): void {
    // Only a press that started on the canvas can be a tap.
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size < 2) this.pinch0 = 0;
    if (this.dragged < 8 && this.pointers.size === 0) this.onTap(e.clientX, e.clientY);
  }

  private wheel(e: WheelEvent): void {
    if (this.mode !== "sky" || !this.enabled) return;
    e.preventDefault();
    this.setFov(this.fov * Math.exp(e.deltaY * 0.0012));
    this.onInteract();
  }
}
