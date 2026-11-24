import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type FrameFn = (dt: number, time: number) => void;

/** Renderer, scene, camera, environment lighting and the frame loop. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.05, 600);
  private frames: FrameFn[] = [];
  private last = 0;
  private fps = { on: new URLSearchParams(location.search).has("fps"), n: 0, t: 0 };

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene.background = new THREE.Color(0x020308);

    // Neutral studio reflections for the brass, kept low so the scene stays a night scene.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xffdcae, 2.4);
    key.position.set(-2.5, 4.5, 2.2);
    const rim = new THREE.DirectionalLight(0x8fa8ff, 0.7);
    rim.position.set(3, 1.5, -4);
    this.scene.add(key, rim);

    addEventListener("resize", () => this.resize());
    this.resize();
  }

  get aspect(): number {
    return this.camera.aspect;
  }

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  onFrame(fn: FrameFn): void {
    this.frames.push(fn);
  }

  start(): void {
    this.renderer.setAnimationLoop((now: number) => {
      const t = now / 1000;
      const dt = this.last ? Math.min(t - this.last, 1 / 15) : 1 / 60;
      this.last = t;
      for (const f of this.frames) f(dt, t);
      this.renderer.render(this.scene, this.camera);
      if (this.fps.on) this.logFps(dt);
    });
  }

  private logFps(dt: number): void {
    this.fps.n++;
    this.fps.t += dt;
    if (this.fps.t >= 2) {
      console.log(`[fps] ${(this.fps.n / this.fps.t).toFixed(1)}`);
      this.fps.n = 0;
      this.fps.t = 0;
    }
  }
}
