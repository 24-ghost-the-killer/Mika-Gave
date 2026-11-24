//! Browser core compiled to WebAssembly.
//!
//! * [`vault`]: unlocks the payload and decrypts blobs. Used only inside the crypto Web Worker.
//! * [`sky`]: star catalog, alt/az for a date and place, planisphere projection, sun altitude.
//! * [`springs`]: damped spring integrators for particles, rings and camera.
//! * [`geometry`]: procedural brass planisphere meshes.

pub mod geometry;
pub mod sky;
pub mod springs;
pub mod vault;
