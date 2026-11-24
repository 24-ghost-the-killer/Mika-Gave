//! Damped springs. They drive every motion in the scene, so movement has weight and
//! follow-through instead of tweened easing curves.
//!
//! The integrator is semi-implicit Euler with fixed sub-steps (≤ 1/240 s). It stays stable
//! for the stiffnesses used here and is frame-rate independent.
//!
//! Buffers are exposed as raw pointers into wasm memory. JS wraps them in a
//! `Float32Array(memory.buffer, ptr, len)` and hands that straight to a three.js
//! `BufferAttribute`, so nothing is copied per frame.

use wasm_bindgen::prelude::*;

const MAX_STEP: f32 = 1.0 / 240.0;
/// Larger frame gaps (a background tab, a GC pause) are clamped so the simulation doesn't explode.
const MAX_FRAME: f32 = 1.0 / 15.0;

/// Damping coefficient c for stiffness k (unit mass) and damping ratio ζ (1 = critical).
fn damping(k: f32, zeta: f32) -> f32 {
    2.0 * zeta * k.sqrt()
}

/// A small bank of independent scalar springs: camera position, look target, ring angles, lid hinge.
#[wasm_bindgen]
pub struct SpringBank {
    x: Vec<f32>,
    v: Vec<f32>,
    target: Vec<f32>,
    k: Vec<f32>,
    c: Vec<f32>,
}

#[wasm_bindgen]
impl SpringBank {
    #[wasm_bindgen(constructor)]
    pub fn new(n: usize, stiffness: f32, zeta: f32) -> SpringBank {
        SpringBank {
            x: vec![0.0; n],
            v: vec![0.0; n],
            target: vec![0.0; n],
            k: vec![stiffness; n],
            c: vec![damping(stiffness, zeta); n],
        }
    }

    /// Change one channel's character. The camera wants soft and critical, the hinge a slight overshoot.
    pub fn tune(&mut self, i: usize, stiffness: f32, zeta: f32) {
        self.k[i] = stiffness;
        self.c[i] = damping(stiffness, zeta);
    }

    /// Snap a channel to a value with zero velocity.
    pub fn set(&mut self, i: usize, value: f32) {
        self.x[i] = value;
        self.target[i] = value;
        self.v[i] = 0.0;
    }

    #[wasm_bindgen(js_name = setTarget)]
    pub fn set_target(&mut self, i: usize, value: f32) {
        self.target[i] = value;
    }

    /// Add velocity, e.g. the "no" wobble on a wrong key.
    pub fn kick(&mut self, i: usize, dv: f32) {
        self.v[i] += dv;
    }

    pub fn get(&self, i: usize) -> f32 {
        self.x[i]
    }

    pub fn velocity(&self, i: usize) -> f32 {
        self.v[i]
    }

    pub fn target(&self, i: usize) -> f32 {
        self.target[i]
    }

    pub fn step(&mut self, dt: f32) {
        let dt = dt.clamp(0.0, MAX_FRAME);
        let n = (dt / MAX_STEP).ceil().max(1.0) as usize;
        let h = dt / n as f32;
        for _ in 0..n {
            for i in 0..self.x.len() {
                let a = -self.k[i] * (self.x[i] - self.target[i]) - self.c[i] * self.v[i];
                self.v[i] += a * h;
                self.x[i] += self.v[i] * h;
            }
        }
    }

    /// True once every channel is within `eps` of its target and nearly still.
    pub fn settled(&self, eps: f32) -> bool {
        self.x.iter().zip(&self.target).zip(&self.v).all(|((x, t), v)| (x - t).abs() < eps && v.abs() < eps * 10.0)
    }
}

/// Thousands of 3D particles, each springing towards its own target after its own delay.
/// Stars rise from the plate to the dome with this. The delays give the rise a ripple.
#[wasm_bindgen]
pub struct Particles {
    pos: Vec<f32>,
    vel: Vec<f32>,
    target: Vec<f32>,
    delay: Vec<f32>,
    clock: f32,
    k: f32,
    c: f32,
}

#[wasm_bindgen]
impl Particles {
    #[wasm_bindgen(constructor)]
    pub fn new(n: usize, stiffness: f32, zeta: f32) -> Particles {
        Particles {
            pos: vec![0.0; n * 3],
            vel: vec![0.0; n * 3],
            target: vec![0.0; n * 3],
            delay: vec![0.0; n],
            clock: 0.0,
            k: stiffness,
            c: damping(stiffness, zeta),
        }
    }

    pub fn len(&self) -> usize {
        self.delay.len()
    }

    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.delay.is_empty()
    }

    pub fn tune(&mut self, stiffness: f32, zeta: f32) {
        self.k = stiffness;
        self.c = damping(stiffness, zeta);
    }

    /// Teleport every particle to `p` (3 floats each) with zero velocity.
    #[wasm_bindgen(js_name = setPositions)]
    pub fn set_positions(&mut self, p: &[f32]) {
        let n = p.len().min(self.pos.len());
        self.pos[..n].copy_from_slice(&p[..n]);
        self.vel.fill(0.0);
    }

    /// New targets. The clock restarts, so `delays` count from now.
    #[wasm_bindgen(js_name = setTargets)]
    pub fn set_targets(&mut self, t: &[f32], delays: Option<Vec<f32>>) {
        let n = t.len().min(self.target.len());
        self.target[..n].copy_from_slice(&t[..n]);
        match delays {
            Some(d) => {
                let m = d.len().min(self.delay.len());
                self.delay[..m].copy_from_slice(&d[..m]);
            }
            None => self.delay.fill(0.0),
        }
        self.clock = 0.0;
    }

    pub fn step(&mut self, dt: f32) {
        let dt = dt.clamp(0.0, MAX_FRAME);
        let steps = (dt / MAX_STEP).ceil().max(1.0) as usize;
        let h = dt / steps as f32;
        let (k, c) = (self.k, self.c);
        for _ in 0..steps {
            self.clock += h;
            for (i, &d) in self.delay.iter().enumerate() {
                if self.clock < d {
                    continue;
                }
                for j in i * 3..i * 3 + 3 {
                    let a = -k * (self.pos[j] - self.target[j]) - c * self.vel[j];
                    self.vel[j] += a * h;
                    self.pos[j] += self.vel[j] * h;
                }
            }
        }
    }

    /// Pointer to the xyz position buffer (`3 * len()` floats).
    #[wasm_bindgen(js_name = positionsPtr)]
    pub fn positions_ptr(&self) -> *const f32 {
        self.pos.as_ptr()
    }

    /// Largest distance from target. Below about 1e-3 the animation is done.
    #[wasm_bindgen(js_name = maxError)]
    pub fn max_error(&self) -> f32 {
        self.pos.iter().zip(&self.target).map(|(p, t)| (p - t).abs()).fold(0.0, f32::max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_spring_converges_without_overshoot() {
        let mut s = SpringBank::new(1, 120.0, 1.0);
        s.set_target(0, 1.0);
        let mut max = 0.0f32;
        for _ in 0..240 {
            s.step(1.0 / 60.0);
            max = max.max(s.get(0));
        }
        assert!((s.get(0) - 1.0).abs() < 1e-4);
        assert!(max <= 1.0 + 1e-4, "overshoot {max}");
        assert!(s.settled(1e-3));
    }

    #[test]
    fn underdamped_spring_overshoots() {
        let mut s = SpringBank::new(1, 200.0, 0.3);
        s.set_target(0, 1.0);
        let mut max = 0.0f32;
        for _ in 0..120 {
            s.step(1.0 / 60.0);
            max = max.max(s.get(0));
        }
        assert!(max > 1.2);
    }

    #[test]
    fn frame_rate_independent() {
        let run = |fps: f32| {
            let mut s = SpringBank::new(1, 80.0, 0.7);
            s.set_target(0, 1.0);
            let frames = (fps * 0.4) as usize;
            for _ in 0..frames {
                s.step(1.0 / fps);
            }
            s.get(0)
        };
        assert!((run(30.0) - run(144.0)).abs() < 0.01);
    }

    #[test]
    fn particles_respect_delays() {
        let mut p = Particles::new(2, 100.0, 1.0);
        p.set_positions(&[0.0; 6]);
        p.set_targets(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0], Some(vec![0.0, 0.5]));
        for _ in 0..12 {
            p.step(1.0 / 60.0); // 0.2 s
        }
        assert!(p.pos[0] > 0.3);
        assert_eq!(p.pos[3], 0.0);
        for _ in 0..240 {
            p.step(1.0 / 60.0);
        }
        assert!(p.max_error() < 1e-3);
    }
}
