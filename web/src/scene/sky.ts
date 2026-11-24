import * as THREE from "three";

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // always at the far plane
  }
`;

const fragment = /* glsl */ `
  varying vec3 vDir;
  uniform float uReveal;
  uniform float uSunAlt;
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uGalPole;
  uniform vec3 uGalCenter;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    // Twilight from the real Sun altitude at that moment: 0 at astronomical night, 1 near sunset.
    float tw = smoothstep(-18.0, -1.0, uSunAlt);
    vec3 zenith = mix(vec3(0.0022, 0.0032, 0.009), vec3(0.02, 0.035, 0.09), tw);
    vec3 horizon = mix(vec3(0.014, 0.018, 0.036), vec3(0.22, 0.12, 0.085), tw);
    vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));

    // Warm glow towards the (set) Sun.
    float sd = max(dot(d, uSunDir), 0.0);
    col += vec3(0.5, 0.22, 0.09) * tw * pow(sd, 5.0) * (1.0 - smoothstep(0.0, 0.45, h));
    // Airglow and a whisper of distant town light along the horizon.
    col += vec3(0.03, 0.026, 0.032) * exp(-max(h, 0.0) * 9.0);

    // The Milky Way, oriented from the real galactic pole and centre for that sky.
    float b = dot(d, uGalPole);
    // A smooth glow plus fine structure, never big blotches.
    // Noise is only evaluated near the band, so most of the sky costs almost nothing.
    float band = exp(-b * b * 38.0);
    if (band > 0.01 && uReveal > 0.0 && h > -0.05) {
      float core = 0.5 + 0.5 * dot(d, uGalCenter);
      float fine = fbm(d * 14.0);
      float clumps = noise(d * 6.0 + 7.0);
      float mw = band * (0.3 + 1.2 * core * core) * (0.55 + 0.7 * smoothstep(0.38, 0.8, fine) * (0.8 + 0.2 * clumps));
      float lane = b * b < 0.02 ? smoothstep(0.45, 0.7, fbm(d * 18.0 + 3.0)) * exp(-b * b * 220.0) : 0.0;
      mw *= 1.0 - 0.6 * lane;
      col += vec3(0.05, 0.048, 0.06) * mw * (1.0 - tw * 0.8) * smoothstep(-0.02, 0.3, h);
    }

    // Before the reveal: a near-black void with the faintest vignette of warmth below.
    vec3 voidCol = vec3(0.006, 0.007, 0.014) + vec3(0.012, 0.009, 0.006) * smoothstep(0.2, -0.6, h);
    col = mix(voidCol, col, uReveal);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // Dither after encoding to stop banding in the dark gradient.
    gl_FragColor.rgb += (hash(vec3(gl_FragCoord.xy, fract(uTime) * 61.0)) - 0.5) / 255.0;
  }
`;

/** The sky dome behind everything. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uReveal: { value: 0 },
    uSunAlt: { value: -40 },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, -1, 0) },
    uGalPole: { value: new THREE.Vector3(0, 1, 0) },
    uGalCenter: { value: new THREE.Vector3(0, 0, 1) },
  };

  constructor() {
    const material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 64, 32), material);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  /** Follow the camera so the dome is always centred on the viewer. */
  update(camera: THREE.Camera, t: number): void {
    this.mesh.position.copy(camera.position);
    this.uniforms.uTime.value = t;
  }
}

/**
 * The ground and a low, soft treeline silhouette. They fade in with the sky and give the
 * horizon a place to be.
 */
export class Horizon {
  readonly group = new THREE.Group();
  private materials: THREE.MeshBasicMaterial[] = [];

  constructor() {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(56, 96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x020306, transparent: true, opacity: 0, depthWrite: false }),
    );
    ground.position.y = -0.071;
    ground.renderOrder = -5;

    // Silhouette: a ring whose height is a sum of slow sines (hills) and fast ones (tree tops).
    const N = 720;
    const R = 52; // inside the star dome (60), so the ridge hides the lowest stars
    const H = R / 140; // heights below were tuned at R = 140
    const pos = new Float32Array((N + 1) * 2 * 3);
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const hill = 1.2 + 0.9 * Math.sin(a * 2 + 0.7) + 0.6 * Math.sin(a * 5 + 2.1) + 0.35 * Math.sin(a * 11 + 0.3);
      const trees = Math.max(0, Math.sin(a * 37 + 1.3)) * 0.5 + Math.max(0, Math.sin(a * 83 + 4.2)) * 0.35 + Math.abs(Math.sin(a * 151)) * 0.2;
      const y = Math.max(0.4, hill + trees * (0.5 + 0.5 * Math.sin(a * 3 + 1))) * H;
      pos.set([R * Math.sin(a), -1, R * Math.cos(a)], i * 6);
      pos.set([R * Math.sin(a), y, R * Math.cos(a)], i * 6 + 3);
    }
    const idx: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    const ridge = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x010204, side: THREE.DoubleSide, transparent: true, opacity: 0 }));
    ridge.renderOrder = -4;

    this.materials = [ground.material as THREE.MeshBasicMaterial, ridge.material as THREE.MeshBasicMaterial];
    this.group.add(ground, ridge);
    this.group.visible = false;
  }

  setOpacity(o: number): void {
    this.group.visible = o > 0.001;
    for (const m of this.materials) {
      m.opacity = o;
      m.transparent = o < 0.999;
      m.depthWrite = o >= 0.999;
    }
  }
}
