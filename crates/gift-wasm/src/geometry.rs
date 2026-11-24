//! Procedural brass planisphere geometry.
//!
//! * `lathe`: a turned profile with crisp chamfers. Normals split at creases sharper than
//!   ~30°, the way a machined part catches light.
//! * `windowCover`: the cover plate with the horizon window cut out of it, and a bevelled
//!   inner wall so the cut has depth.
//! * `radialTransforms`: instance matrices for engraved ticks around a ring.
//!
//! Angles run as x = r·sin θ, z = r·cos θ, so θ = 0 points to +z (south, the meridian).
//! UVs are planar (x, z), so a concentric brushed-metal texture lines up on every top face.

use core::f32::consts::TAU;
use wasm_bindgen::prelude::*;

const CREASE_COS: f32 = 0.866; // cos 30°
/// UV radius. Every part of the planisphere fits inside this.
const UV_R: f32 = 1.4;

#[wasm_bindgen]
#[derive(Default)]
pub struct Mesh {
    positions: Vec<f32>,
    normals: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
}

#[wasm_bindgen]
impl Mesh {
    pub fn positions(&self) -> Vec<f32> {
        self.positions.clone()
    }
    pub fn normals(&self) -> Vec<f32> {
        self.normals.clone()
    }
    pub fn uvs(&self) -> Vec<f32> {
        self.uvs.clone()
    }
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }
}

impl Mesh {
    fn vertex(&mut self, p: [f32; 3], n: [f32; 3]) -> u32 {
        let i = (self.positions.len() / 3) as u32;
        self.positions.extend_from_slice(&p);
        self.normals.extend_from_slice(&n);
        self.uvs.extend_from_slice(&[p[0] / (2.0 * UV_R) + 0.5, p[2] / (2.0 * UV_R) + 0.5]);
        i
    }

    fn pos(&self, i: u32) -> [f32; 3] {
        let i = i as usize * 3;
        [self.positions[i], self.positions[i + 1], self.positions[i + 2]]
    }

    fn nrm(&self, i: u32) -> [f32; 3] {
        let i = i as usize * 3;
        [self.normals[i], self.normals[i + 1], self.normals[i + 2]]
    }

    /// Emit a triangle wound counter-clockwise as seen from its vertex normals.
    /// Degenerate triangles at the lathe axis are skipped.
    fn tri(&mut self, a: u32, b: u32, c: u32) {
        let (pa, pb, pc) = (self.pos(a), self.pos(b), self.pos(c));
        let face = cross(sub(pb, pa), sub(pc, pa));
        if dot(face, face) < 1e-14 {
            return;
        }
        let n = add(add(self.nrm(a), self.nrm(b)), self.nrm(c));
        if dot(face, n) >= 0.0 {
            self.indices.extend_from_slice(&[a, b, c]);
        } else {
            self.indices.extend_from_slice(&[a, c, b]);
        }
    }

    /// Quad strip between two rings of equal length (closed loop).
    fn strip(&mut self, a: &[u32], b: &[u32]) {
        let n = a.len();
        for j in 0..n {
            let k = (j + 1) % n;
            self.tri(a[j], b[j], a[k]);
            self.tri(a[k], b[j], b[k]);
        }
    }
}

/// Turn a profile around the y axis.
///
/// `profile` holds flat (r, y) pairs. Walk it from the axis outwards over the top face and then
/// down the outside. Each segment's outward normal is (−dy, dr), rotated about y.
#[wasm_bindgen]
pub fn lathe(profile: &[f32], segments: u32) -> Mesh {
    let pts: Vec<[f32; 2]> = profile.chunks_exact(2).map(|p| [p[0], p[1]]).collect();
    let seg_n: Vec<[f32; 2]> = pts
        .windows(2)
        .map(|w| {
            let (dr, dy) = (w[1][0] - w[0][0], w[1][1] - w[0][1]);
            let l = dr.hypot(dy).max(1e-9);
            [-dy / l, dr / l]
        })
        .collect();
    let segments = segments.max(3) as usize;
    let mut m = Mesh::default();

    // A profile vertex's normal from segment s: smoothed with the neighbour unless the join is a crease.
    let joined = |s: usize, other: Option<usize>| -> [f32; 2] {
        let a = seg_n[s];
        match other {
            Some(o) if a[0] * seg_n[o][0] + a[1] * seg_n[o][1] > CREASE_COS => {
                let (x, y) = (a[0] + seg_n[o][0], a[1] + seg_n[o][1]);
                let l = x.hypot(y);
                [x / l, y / l]
            }
            _ => a,
        }
    };

    for s in 0..seg_n.len() {
        let n0 = joined(s, s.checked_sub(1));
        let n1 = joined(s, (s + 1 < seg_n.len()).then_some(s + 1));
        let ring = |m: &mut Mesh, p: [f32; 2], n: [f32; 2]| -> Vec<u32> {
            (0..segments)
                .map(|j| {
                    let (st, ct) = (TAU * j as f32 / segments as f32).sin_cos();
                    m.vertex([p[0] * st, p[1], p[0] * ct], [n[0] * st, n[1], n[0] * ct])
                })
                .collect()
        };
        let a = ring(&mut m, pts[s], n0);
        let b = ring(&mut m, pts[s + 1], n1);
        m.strip(&a, &b);
    }
    m
}

/// The cover with the horizon window: a flat top face between `outline` and a circle of radius
/// `outer` at height `y`, plus an inner wall `depth` deep and a slight chamfer on the window edge.
/// `outline` holds (x, z) pairs that must be radial from the origin, as `horizonOutline` returns.
#[wasm_bindgen(js_name = windowCover)]
pub fn window_cover(outline: &[f32], outer: f32, y: f32, depth: f32) -> Mesh {
    let inner: Vec<[f32; 2]> = outline.chunks_exact(2).map(|p| [p[0], p[1]]).collect();
    let mut m = Mesh::default();
    let up = [0.0, 1.0, 0.0];
    let chamfer = depth * 0.6;

    let dir = |p: [f32; 2]| {
        let l = p[0].hypot(p[1]).max(1e-9);
        [p[0] / l, p[1] / l]
    };

    // Top face, from the chamfer start out to the rim.
    let top_in: Vec<u32> = inner
        .iter()
        .map(|&p| {
            let d = dir(p);
            m.vertex([p[0] + d[0] * chamfer, y, p[1] + d[1] * chamfer], up)
        })
        .collect();
    let top_out: Vec<u32> = inner
        .iter()
        .map(|&p| {
            let d = dir(p);
            m.vertex([d[0] * outer, y, d[1] * outer], up)
        })
        .collect();
    m.strip(&top_in, &top_out);

    // 45° chamfer facing up and into the window.
    let cn = |p: [f32; 2]| {
        let d = dir(p);
        let s = core::f32::consts::FRAC_1_SQRT_2;
        [-d[0] * s, s, -d[1] * s]
    };
    let ch_top: Vec<u32> = inner
        .iter()
        .map(|&p| {
            let d = dir(p);
            m.vertex([p[0] + d[0] * chamfer, y, p[1] + d[1] * chamfer], cn(p))
        })
        .collect();
    let ch_bot: Vec<u32> = inner.iter().map(|&p| m.vertex([p[0], y - chamfer, p[1]], cn(p))).collect();
    m.strip(&ch_top, &ch_bot);

    // Vertical inner wall.
    let wn = |p: [f32; 2]| {
        let d = dir(p);
        [-d[0], 0.0, -d[1]]
    };
    let w_top: Vec<u32> = inner.iter().map(|&p| m.vertex([p[0], y - chamfer, p[1]], wn(p))).collect();
    let w_bot: Vec<u32> = inner.iter().map(|&p| m.vertex([p[0], y - depth, p[1]], wn(p))).collect();
    m.strip(&w_top, &w_bot);
    m
}

/// Column-major 4×4 matrices (16 floats each) that place `n` instances evenly around a ring of
/// `radius` at height `y`. Each instance's local +z points radially outwards. `scales` holds
/// optional per-instance (sx, sy, sz); if it is empty, every scale is 1. `phase` turns the whole ring.
#[wasm_bindgen(js_name = radialTransforms)]
pub fn radial_transforms(n: u32, radius: f32, y: f32, phase: f32, scales: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(n as usize * 16);
    for i in 0..n as usize {
        let th = phase + TAU * i as f32 / n as f32;
        let (s, c) = th.sin_cos();
        let (sx, sy, sz) = match scales.get(i * 3..i * 3 + 3) {
            Some(v) => (v[0], v[1], v[2]),
            None => (1.0, 1.0, 1.0),
        };
        // Ry(θ)·S. The columns are the rotated basis vectors scaled.
        out.extend_from_slice(&[
            c * sx, 0.0, -s * sx, 0.0, //
            0.0, sy, 0.0, 0.0, //
            s * sz, 0.0, c * sz, 0.0, //
            radius * s, y, radius * c, 1.0,
        ]);
    }
    out
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face_normals_agree(m: &Mesh) {
        for t in m.indices.chunks_exact(3) {
            let (a, b, c) = (m.pos(t[0]), m.pos(t[1]), m.pos(t[2]));
            let f = cross(sub(b, a), sub(c, a));
            let n = add(add(m.nrm(t[0]), m.nrm(t[1])), m.nrm(t[2]));
            assert!(dot(f, n) > 0.0);
        }
    }

    #[test]
    fn lathe_disc_faces_up_and_box_corner_creases() {
        // Disc top, then a 90° edge down the side.
        let m = lathe(&[0.0, 0.1, 1.0, 0.1, 1.0, 0.0], 32);
        face_normals_agree(&m);
        // Side vertices have horizontal normals (crease kept), top vertices vertical ones.
        assert!(m.normals.chunks_exact(3).all(|n| n[1].abs() > 0.999 || n[1].abs() < 1e-6));
        assert!(m.indices.iter().all(|&i| (i as usize) < m.positions.len() / 3));
    }

    #[test]
    fn lathe_smooths_gentle_curves() {
        let prof: Vec<f32> = (0..=8).flat_map(|i| {
            let a = i as f32 / 8.0 * 0.5;
            [a.sin(), a.cos()]
        }).collect();
        let m = lathe(&prof, 16);
        face_normals_agree(&m);
        // Mid-profile vertices aren't purely the facet normal: neither 0 nor ±1 in y.
        assert!(m.normals.chunks_exact(3).any(|n| n[1] > 0.0 && n[1] < 0.999));
    }

    #[test]
    fn window_cover_is_consistent() {
        let outline = crate::sky::horizon_outline(55.7, 96);
        let m = window_cover(&outline, 1.05, 0.02, 0.01);
        face_normals_agree(&m);
        assert!(!m.indices.is_empty());
    }

    #[test]
    fn radial_transform_places_and_orients() {
        let t = radial_transforms(4, 2.0, 0.5, 0.0, &[]);
        assert_eq!(t.len(), 64);
        // Instance 1 at θ = 90°: position (+2, 0.5, 0), local +z → +x.
        let m = &t[16..32];
        assert!((m[12] - 2.0).abs() < 1e-6 && (m[13] - 0.5).abs() < 1e-6 && m[14].abs() < 1e-6);
        assert!((m[8] - 1.0).abs() < 1e-6 && m[10].abs() < 1e-6);
    }
}
