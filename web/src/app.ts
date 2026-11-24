import * as THREE from "three";
import { CryptoClient } from "./crypto/client";
import type { Manifest } from "./manifest";
import { t } from "./strings.da";
import { Sky, domePoint, loadWasm, siderealAngle, sunAltitude, sunDirection } from "./wasm";
import { CameraRig } from "./scene/camera";
import { Constellation } from "./scene/constellation";
import { Planisphere } from "./scene/planisphere";
import { Horizon, SkyDome } from "./scene/sky";
import { Stage } from "./scene/stage";
import { Stars } from "./scene/stars";
import { Card } from "./ui/card";
import { wait } from "./ui/dom";
import { renderFallback } from "./ui/fallback";
import { Letter } from "./ui/letter";
import { LockUI } from "./ui/lock";
import { Overlay, notice } from "./ui/overlay";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Small eased ramps for fades. Motion uses springs; opacity and reveal ramps use these. */
class Tweens {
  private list: { t: number; d: number; fn: (v: number) => void; done: () => void }[] = [];
  run(seconds: number, fn: (v: number) => void): Promise<void> {
    return new Promise((done) => this.list.push({ t: 0, d: reduced ? Math.min(seconds, 0.4) : seconds, fn, done }));
  }
  update(dt: number): void {
    this.list = this.list.filter((tw) => {
      tw.t += dt;
      const x = Math.min(1, tw.t / tw.d);
      tw.fn(x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      if (x >= 1) tw.done();
      return x < 1;
    });
  }
}

function hasWebGL2(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Ask for the key until it fits. Each wrong try shakes the lid. */
function askForKey(client: CryptoClient, lock: LockUI, onLength: (n: number) => void, onBusy: (b: boolean) => void, onWrong: () => void): Promise<Manifest> {
  return new Promise((resolve) => {
    lock.onLength = onLength;
    lock.onSubmit = async (pass) => {
      lock.busy(true);
      onBusy(true);
      const t0 = performance.now();
      const m = await client.unlockPassphrase(pass).catch(() => null);
      // Let the "turning" moment read even on fast machines.
      await wait(Math.max(0, (reduced ? 200 : 1100) - (performance.now() - t0)));
      onBusy(false);
      if (m) resolve(m);
      else {
        onWrong();
        lock.wrong();
      }
    };
  });
}

export async function start(token: string): Promise<void> {
  const ui = document.getElementById("ui")!;
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  const client = new CryptoClient();
  const hasPass = client.hasPassphrase();
  hasPass.catch(() => notice(ui, t.failed));

  if (!hasWebGL2()) {
    canvas.remove();
    const m = (token && (await client.unlockLink(token).catch(() => null))) || (await unlockWithPrompt(client, ui, !!token));
    if (m) renderFallback(ui, m, (id) => client.photo(id));
    return;
  }

  const [, catalog] = await Promise.all([
    loadWasm(),
    fetchBytes("/stars.bin"),
    document.fonts.load('500 40px "Instrument Sans Variable"'),
    document.fonts.load('500 40px "Fraunces Variable"'),
  ]);

  // ---------- scene ----------
  const stage = new Stage(canvas);
  const tweens = new Tweens();
  const plani = new Planisphere(reduced);
  const sky = new Sky(catalog);
  const stars = new Stars(sky, reduced);
  const dome = new SkyDome();
  const horizon = new Horizon();
  const rig = new CameraRig(stage.camera, canvas, reduced);
  stage.scene.add(dome.mesh, horizon.group, plani.group);
  stars.sitOnPlate(plani.wheel, 55.7);
  let constellation: Constellation | null = null;

  stage.onFrame((dt, time) => {
    tweens.update(dt);
    plani.update(dt, time);
    rig.update(dt);
    stars.update(dt, time, rig.zoom);
    constellation?.update(time, rig.zoom);
    dome.update(stage.camera, time);
  });
  canvas.addEventListener("webglcontextlost", () => notice(ui, t.contextLost));
  stage.start();
  document.body.classList.add("is-ready");
  // Dev-only handle for debugging in the console. Vite removes this branch from production builds.
  if (import.meta.env.DEV) Object.assign(window, { __gift: { stage, rig, stars, sky, THREE } });

  // ---------- unlock ----------
  let manifest: Manifest | null = null;
  if (token) manifest = await client.unlockLink(token).catch(() => null);
  if (!manifest) {
    if (!(await hasPass.catch(() => false))) {
      notice(ui, t.linkOnly);
      return;
    }
    const lock = new LockUI(ui);
    if (token) lock.say(t.linkStale);
    lock.show();
    manifest = await askForKey(
      client,
      lock,
      (n) => plani.setTyped(n),
      (b) => plani.setDeriving(b),
      () => plani.reject(),
    );
    lock.leave();
  }
  const m = manifest;

  // ---------- unfold ----------
  const { lat, lon, when_ms: ms } = m.sky;
  plani.setLatitude(lat);
  stars.sitOnPlate(plani.wheel, lat);
  await wait(reduced ? 0 : 350);
  plani.openLid();
  await wait(reduced ? 100 : 650);
  plani.turnTo(siderealAngle(ms, lon));
  const t0 = performance.now();
  while (!plani.wheelSettled && performance.now() - t0 < 3200) await wait(50);
  await wait(reduced ? 0 : 250);

  dome.uniforms.uSunAlt.value = sunAltitude(ms, lat, lon);
  dome.uniforms.uSunDir.value.fromArray(sunDirection(ms, lat, lon));
  dome.uniforms.uGalPole.value.fromArray(domePoint(192.85948, 27.12825, ms, lat, lon));
  dome.uniforms.uGalCenter.value.fromArray(domePoint(266.405, -28.936, ms, lat, lon));

  const domeDirs = sky.dome(ms, lat, lon);
  const mags = sky.magnitudes();
  const bright: THREE.Vector3[] = [];
  for (let i = 0; i < mags.length && mags[i] < 2.2; i++) bright.push(new THREE.Vector3().fromArray(domeDirs, i * 3));
  constellation = new Constellation(m.memories, lat, bright, THREE.MathUtils.clamp(innerWidth / innerHeight, 0.62, 1));
  stage.scene.add(constellation.group);
  const centre = constellation.dirs.reduce((a, d) => a.add(d), new THREE.Vector3()).normalize();
  rig.skyView(Math.atan2(centre.x, centre.z), THREE.MathUtils.clamp(Math.asin(centre.y) - 0.05, 0.2, 0.9));
  stars.rise(stage.scene, domeDirs, reduced);
  tweens.run(4, (v) => {
    dome.uniforms.uReveal.value = v;
    horizon.setOpacity(v);
  });
  await wait(reduced ? 300 : 3600);
  const c = constellation;
  tweens.run(2.2, (v) => (c.reveal = v));
  await wait(reduced ? 100 : 900);
  await tweens.run(3, (v) => (c.progress = v));

  explore(m, c, rig, stage.camera, ui, client);
}

function explore(m: Manifest, c: Constellation, rig: CameraRig, camera: THREE.Camera, ui: HTMLElement, client: CryptoClient): void {
  const overlay = new Overlay(ui, m);
  const card = new Card(ui);
  const letter = new Letter(ui, m);
  const photo = (id: string) => client.photo(id);
  const visited = new Set<number>();
  const wide = () => innerWidth >= 760;
  let current = -1;

  overlay.showIntro();
  overlay.onBegin = () => {
    overlay.hideIntro();
    overlay.showChrome();
  };

  const openMemory = (i: number) => {
    if (overlay.introOpen) overlay.onBegin();
    current = i;
    card.open(m.memories[i], i, m.memories.length, photo);
    c.setFocus(i);
    c.markVisited(i);
    visited.add(i);
    overlay.dim(true);
    if (visited.size === m.memories.length) overlay.showLetterButton();
    const f = rig.currentFov;
    rig.focus(c.dirs[i], wide() ? -0.22 * (f / 50) : 0, wide() ? 0 : -0.36 * (f / 60));
  };
  const closeCard = () => {
    card.close();
    c.setFocus(-1);
    overlay.dim(false);
    current = -1;
  };
  const openLetter = () => {
    if (overlay.introOpen) overlay.onBegin();
    closeCard();
    c.markVisited(c.letterIndex);
    c.setFocus(c.letterIndex);
    rig.focus(c.dirs[c.letterIndex], 0, -0.05);
    rig.enabled = false;
    overlay.dim(true);
    overlay.showLetterButton();
    letter.open();
  };
  const closeLetter = () => {
    letter.close();
    c.setFocus(-1);
    rig.enabled = true;
    overlay.dim(false);
  };

  card.onClose = closeCard;
  card.onNext = () => openMemory(Math.min(current + 1, m.memories.length - 1));
  card.onPrev = () => openMemory(Math.max(current - 1, 0));
  card.onLetter = openLetter;
  letter.onClose = closeLetter;
  overlay.onLetter = openLetter;

  rig.onTap = (x, y) => {
    if (letter.isOpen) return;
    const i = c.pick(x, y, camera);
    if (i === c.letterIndex) openLetter();
    else if (i >= 0) openMemory(i);
    else if (card.isOpen) closeCard();
    else if (overlay.introOpen) overlay.onBegin();
  };
  rig.onHover = (x, y) => {
    const i = letter.isOpen ? -1 : c.pick(x, y, camera);
    c.setHover(i);
    document.body.classList.toggle("is-pointing", i >= 0);
  };
  rig.onInteract = () => {
    overlay.hideHint();
    if (overlay.introOpen) overlay.onBegin();
  };

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (letter.isOpen) return;
    if (e.key === "Escape" && card.isOpen) closeCard();
    if (e.key === "ArrowRight" && card.isOpen) card.onNext();
    if (e.key === "ArrowLeft" && card.isOpen) card.onPrev();
  });

  // Decrypt photos in the background so cards open instantly.
  (async () => {
    for (const mem of m.memories) if (mem.photo) await client.photo(mem.photo.id).catch(() => {});
  })();
}

/** No-WebGL path: the same prompt without the planisphere. */
async function unlockWithPrompt(client: CryptoClient, ui: HTMLElement, hadToken: boolean): Promise<Manifest | null> {
  if (!(await client.hasPassphrase().catch(() => false))) {
    notice(ui, t.linkOnly);
    return null;
  }
  const lock = new LockUI(ui);
  if (hadToken) lock.say(t.linkStale);
  lock.show();
  const m = await askForKey(client, lock, () => {}, () => {}, () => {});
  lock.leave();
  return m;
}
