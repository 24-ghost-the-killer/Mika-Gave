import * as THREE from "three";
import { Particles, type Sky, f32View } from "../wasm";
import { PLATE_SCALE, STAR_Y } from "./planisphere";

export const DOME_R = 60;

const vertex = /* glsl */ `
  attribute float aMag;
  attribute vec3 aColor;
  attribute float aSeed;
  attribute float aPlateR;
  uniform float uPixelRatio;
  uniform float uZoom;
  uniform float uTime;
  uniform float uTwinkle;
  uniform float uPlateMag;
  uniform float uSkyMag;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlow;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    // 0 on the plate, 1 in the sky. Every star morphs on its own as it flies.
    float sky = smoothstep(2.0, 40.0, length(position));
    float b = pow(10.0, -0.4 * (aMag - 1.0));
    float limit = mix(uPlateMag, uSkyMag, sky);
    float visible = smoothstep(limit + 0.4, limit - 0.4, aMag);
    // On the plate, hide stars outside the cover (they would sit on the date ring).
    visible *= mix(step(aPlateR, 0.965), 1.0, sky);

    float size = mix(1.1 + 1.6 * pow(b, 0.3), (1.8 + 8.0 * pow(b, 0.48)) * uZoom, sky);
    float alpha = clamp(pow(b, 0.42) * 1.7, mix(0.07, 0.2, sky), 1.0);

    // Horizon: extinction dims and warms low stars; below the horizon they vanish.
    float y = normalize(position + vec3(0.0, 1e-5, 0.0)).y;
    float ext = smoothstep(0.0, 0.3, y);
    float horizon = mix(1.0, smoothstep(-0.005, 0.03, y) * mix(0.35, 1.0, ext), sky);
    vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(1.0), mix(1.0, ext, sky));

    // Scintillation: stronger near the horizon, none for reduced motion.
    float tw = 1.0 + uTwinkle * sky * (0.12 + 0.3 * (1.0 - ext)) * sin(uTime * (1.7 + aSeed * 3.1) + aSeed * 61.0);

    vColor = aColor * tint;
    vGlow = smoothstep(2.5, -0.5, aMag) * sky;
    vAlpha = alpha * visible * horizon * tw;
    gl_PointSize = max(size, 1.0) * uPixelRatio;
  }
`;

const fragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlow;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0 || vAlpha < 0.004) discard;
    // Tight core for every star; bright ones also get a soft halo, as the eye sees them.
    float core = exp(-r2 * mix(9.0, 22.0, vGlow));
    float halo = vGlow * 0.32 * exp(-r2 * 3.0);
    float a = (core + halo) * (1.0 - r2);
    gl_FragColor = vec4(vColor * (1.15 + 0.6 * vGlow), a * vAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * All ~9000 catalog stars as one Points draw. Positions live in a wasm `Particles` buffer:
 * the plate projection while they sit on the star wheel, springing to the dome when they rise.
 */
export class Stars {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private geometry = new THREE.BufferGeometry();
  private particles: Particles;
  private position: THREE.BufferAttribute;
  private plateR: THREE.BufferAttribute;
  private mags: Float32Array;
  private rising = false;
  readonly n: number;

  constructor(
    private sky: Sky,
    reducedMotion: boolean,
  ) {
    this.n = sky.len();
    this.particles = new Particles(this.n, 3.2, 0.92);
    this.mags = sky.magnitudes();
    this.position = new THREE.BufferAttribute(this.view(), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.plateR = new THREE.BufferAttribute(new Float32Array(this.n), 1);
    const seeds = new Float32Array(this.n).map((_, i) => ((i * 0.618034) % 1) * 0.999);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("aMag", new THREE.BufferAttribute(this.mags, 1));
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(sky.colors(), 3));
    this.geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    this.geometry.setAttribute("aPlateR", this.plateR);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DOME_R * 1.1);

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
        uTwinkle: { value: reducedMotion ? 0 : 1 },
        uPlateMag: { value: 4.6 },
        uSkyMag: { value: 6.6 },
      },
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  private view(): Float32Array {
    return f32View(this.particles.positionsPtr(), this.n * 3);
  }

  /** Place the stars on the wheel (in the wheel's own frame) for a latitude, and attach them to it. */
  sitOnPlate(wheel: THREE.Object3D, lat: number): void {
    const plate = this.sky.plate(0, lat);
    for (let i = 0; i < this.n; i++) this.plateR.array[i] = Math.hypot(plate[i * 3], plate[i * 3 + 2]);
    this.plateR.needsUpdate = true;
    this.particles.setPositions(plate);
    this.particles.setTargets(plate, null);
    this.points.scale.setScalar(PLATE_SCALE);
    this.points.position.set(0, STAR_Y, 0);
    wheel.add(this.points);
    this.refresh();
  }

  /**
   * Rise into the dome. The stars leave the wheel at their current world position and spring to
   * `dome` (unit vectors from Rust `Sky::dome`). The brightest go first, so the sky fills in like dusk.
   */
  rise(scene: THREE.Scene, dome: Float32Array, reduced: boolean): void {
    this.points.updateWorldMatrix(true, false);
    const m = this.points.matrixWorld;
    const v = new THREE.Vector3();
    const start = new Float32Array(this.n * 3);
    const local = this.view();
    for (let i = 0; i < this.n; i++) {
      v.fromArray(local, i * 3).applyMatrix4(m).toArray(start, i * 3);
    }
    scene.attach(this.points);
    this.points.position.set(0, 0, 0);
    this.points.rotation.set(0, 0, 0);
    this.points.scale.setScalar(1);

    const targets = dome.map((x) => x * DOME_R);
    // Rank by magnitude (the catalog is sorted brightest first).
    const delays = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const rank = i / this.n;
      delays[i] = reduced ? 0 : 0.05 + 2.2 * Math.pow(rank, 0.6) + ((i * 0.7548776) % 1) * 0.35;
    }
    if (reduced) {
      this.particles.setPositions(targets);
    } else {
      this.particles.setPositions(start);
    }
    this.particles.setTargets(targets, delays);
    this.rising = true;
    this.refresh();
  }

  update(dt: number, t: number, zoom: number): void {
    this.material.uniforms.uTime.value = t;
    this.material.uniforms.uZoom.value = zoom;
    if (!this.rising) return;
    this.particles.step(dt);
    this.refresh();
    if (this.particles.maxError() < 1e-3) this.rising = false;
  }

  get settled(): boolean {
    return !this.rising;
  }

  private refresh(): void {
    // wasm memory may have grown, which detaches old views.
    if ((this.position.array as Float32Array).byteLength === 0 || this.position.array.buffer !== this.view().buffer) {
      this.position.array = this.view();
    }
    this.position.needsUpdate = true;
  }
}
