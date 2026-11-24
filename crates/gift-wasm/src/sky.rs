//! Sky math. Star catalog → horizon coordinates for a moment and place, the planisphere
//! (star wheel) projection, star colours from temperature, and the Sun's altitude.
//!
//! Conventions (three.js, y up): north = −z, east = +x, zenith = +y. Azimuth is measured
//! from north towards east. The catalog is J2000. Precession is ignored, which costs
//! about 0.35° over 25 years and is invisible at this scale.

use core::f64::consts::{PI, TAU};
use wasm_bindgen::prelude::*;

/// Bytes per catalog record: ra f32 (rad), dec f32 (rad), mag i16 (×100), temperature u16 (K).
pub const RECORD: usize = 12;
const DEG: f64 = PI / 180.0;
/// The plate keeps a small brass margin outside the southern horizon.
const PLATE_FILL: f64 = 0.92;

#[wasm_bindgen]
pub struct Sky {
    ra: Vec<f64>,
    dec: Vec<f64>,
    mag: Vec<f32>,
    kelvin: Vec<f32>,
}

#[wasm_bindgen]
impl Sky {
    /// Parse `stars.bin`.
    #[wasm_bindgen(constructor)]
    pub fn new(catalog: &[u8]) -> Result<Sky, JsError> {
        Sky::parse(catalog).ok_or_else(|| JsError::new("bad star catalog"))
    }

    pub fn len(&self) -> usize {
        self.ra.len()
    }

    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.ra.is_empty()
    }

    /// Visual magnitudes, one per star.
    pub fn magnitudes(&self) -> Vec<f32> {
        self.mag.clone()
    }

    /// Linear RGB per star (3 floats), gently desaturated so the sky reads as one palette.
    pub fn colors(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.len() * 3);
        for &k in &self.kelvin {
            let [r, g, b] = kelvin_to_rgb(k as f64);
            // Desaturate 35 % towards luminance, then normalise the brightest channel to 1.
            let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let mix = |c: f64| l + (c - l) * 0.65;
            let (r, g, b) = (mix(r), mix(g), mix(b));
            let m = r.max(g).max(b).max(1e-6);
            out.extend_from_slice(&[(r / m) as f32, (g / m) as f32, (b / m) as f32]);
        }
        out
    }

    /// Unit vectors on the dome (3 floats per star) for `unix_ms`, `lat` and `lon` in degrees
    /// (east positive). Stars below the horizon get a negative y, and the shader fades them.
    pub fn dome(&self, unix_ms: f64, lat: f64, lon: f64) -> Vec<f32> {
        let lst = local_sidereal(julian_day(unix_ms), lon);
        let phi = lat * DEG;
        let mut out = Vec::with_capacity(self.len() * 3);
        for i in 0..self.len() {
            let (alt, az) = alt_az(self.ra[i], self.dec[i], lst, phi);
            out.extend_from_slice(&horizon_to_xyz(alt, az));
        }
        out
    }

    /// Positions on the planisphere plate, 3 floats per star (x, 0, z) within the unit disk, for
    /// local sidereal time `lst` (radians; see `siderealAngle`). With `lst = 0` this is the star
    /// wheel's own frame, and turning the wheel by −lst (+lst south of the equator) gives the sky
    /// at that moment. Stars that never rise here land at r > PLATE_FILL, and the caller hides them.
    pub fn plate(&self, lst: f64, lat: f64) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.len() * 3);
        for i in 0..self.len() {
            let (x, z) = plate_xy(self.ra[i], self.dec[i], lst, lat * DEG);
            out.extend_from_slice(&[x as f32, 0.0, z as f32]);
        }
        out
    }
}

impl Sky {
    pub fn parse(b: &[u8]) -> Option<Sky> {
        if b.is_empty() || !b.len().is_multiple_of(RECORD) {
            return None;
        }
        let n = b.len() / RECORD;
        let mut s = Sky {
            ra: Vec::with_capacity(n),
            dec: Vec::with_capacity(n),
            mag: Vec::with_capacity(n),
            kelvin: Vec::with_capacity(n),
        };
        for r in b.chunks_exact(RECORD) {
            s.ra.push(f32::from_le_bytes(r[0..4].try_into().ok()?) as f64);
            s.dec.push(f32::from_le_bytes(r[4..8].try_into().ok()?) as f64);
            s.mag.push(i16::from_le_bytes(r[8..10].try_into().ok()?) as f32 / 100.0);
            let k = u16::from_le_bytes(r[10..12].try_into().ok()?);
            s.kelvin.push(if k == 0 { 6000.0 } else { k as f32 });
        }
        Some(s)
    }
}

/// Unit vector for (alt, az) in radians.
pub fn horizon_to_xyz(alt: f64, az: f64) -> [f32; 3] {
    let c = alt.cos();
    [(c * az.sin()) as f32, alt.sin() as f32, (-c * az.cos()) as f32]
}

/// Julian Day from Unix milliseconds.
pub fn julian_day(unix_ms: f64) -> f64 {
    unix_ms / 86_400_000.0 + 2_440_587.5
}

/// Greenwich mean sidereal time in radians (IAU 1982, accurate to well under a second).
pub fn gmst(jd: f64) -> f64 {
    let d = jd - 2_451_545.0;
    let t = d / 36_525.0;
    let deg = 280.460_618_37 + 360.985_647_366_29 * d + 0.000_387_933 * t * t - t * t * t / 38_710_000.0;
    (deg * DEG).rem_euclid(TAU)
}

/// Local mean sidereal time in radians. `lon` is in degrees, east positive.
pub fn local_sidereal(jd: f64, lon: f64) -> f64 {
    (gmst(jd) + lon * DEG).rem_euclid(TAU)
}

/// Equatorial → horizontal. Every angle is in radians. Returns (altitude, azimuth from north towards east).
pub fn alt_az(ra: f64, dec: f64, lst: f64, phi: f64) -> (f64, f64) {
    let h = lst - ra;
    let (sd, cd) = dec.sin_cos();
    let (sp, cp) = phi.sin_cos();
    let (sh, ch) = h.sin_cos();
    let alt = (sd * sp + cd * cp * ch).clamp(-1.0, 1.0).asin();
    let az = (-cd * sh).atan2(sd * cp - cd * sp * ch).rem_euclid(TAU);
    (alt, az)
}

/// Polar distance of the horizon from the visible celestial pole at hour angle `h`.
fn horizon_polar_distance(h: f64, phi_abs: f64) -> f64 {
    phi_abs.sin().atan2(-phi_abs.cos() * h.cos())
}

/// Planisphere projection: azimuthal equidistant around the visible pole. The pole is at
/// the centre, the southern (northern) horizon at r = PLATE_FILL. The meridian (h = 0) points
/// towards +z, which is the same way it faces in the dome, so the "rise" reads naturally.
pub fn plate_xy(ra: f64, dec: f64, lst: f64, phi: f64) -> (f64, f64) {
    let s = if phi < 0.0 { -1.0 } else { 1.0 };
    let phi_abs = phi.abs().max(1.0 * DEG);
    let h = lst - ra;
    let p = PI / 2.0 - s * dec;
    let r = PLATE_FILL * p / (PI - phi_abs);
    (-r * h.sin(), s * r * h.cos())
}

/// The horizon outline on the plate as `n` (x, z) pairs in hour-angle order. This is the
/// edge of the window cut into the cover. Every point is radial from the pole, so the cover
/// can be triangulated as a ring.
#[wasm_bindgen(js_name = horizonOutline)]
pub fn horizon_outline(lat: f64, n: usize) -> Vec<f32> {
    let phi = lat * DEG;
    let s = if phi < 0.0 { -1.0 } else { 1.0 };
    let phi_abs = phi.abs().max(1.0 * DEG);
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let h = TAU * i as f64 / n as f64;
        let r = PLATE_FILL * horizon_polar_distance(h, phi_abs) / (PI - phi_abs);
        out.extend_from_slice(&[(-r * h.sin()) as f32, (s * r * h.cos()) as f32]);
    }
    out
}

/// Plate angle (radians, about +y) that the star wheel turns through between two moments.
/// The ring animation springs towards this.
#[wasm_bindgen(js_name = siderealAngle)]
pub fn sidereal_angle(unix_ms: f64, lon: f64) -> f64 {
    local_sidereal(julian_day(unix_ms), lon)
}

/// Dome unit vector (x, y, z) for an arbitrary RA/Dec in degrees. The sky shader uses this to
/// orient the Milky Way (galactic pole and centre).
#[wasm_bindgen(js_name = domePoint)]
pub fn dome_point(ra_deg: f64, dec_deg: f64, unix_ms: f64, lat: f64, lon: f64) -> Vec<f32> {
    let lst = local_sidereal(julian_day(unix_ms), lon);
    let (alt, az) = alt_az(ra_deg * DEG, dec_deg * DEG, lst, lat * DEG);
    horizon_to_xyz(alt, az).to_vec()
}

/// Dome unit vector towards the Sun, used for the twilight glow.
#[wasm_bindgen(js_name = sunDirection)]
pub fn sun_direction(unix_ms: f64, lat: f64, lon: f64) -> Vec<f32> {
    let jd = julian_day(unix_ms);
    let (ra, dec) = sun_equatorial(jd);
    let (alt, az) = alt_az(ra, dec, local_sidereal(jd, lon), lat * DEG);
    horizon_to_xyz(alt, az).to_vec()
}

/// The Sun's altitude in degrees (low-precision almanac formula, better than 0.1°). This
/// drives the sky gradient: night, blue hour or dusk at the chosen moment.
#[wasm_bindgen(js_name = sunAltitude)]
pub fn sun_altitude(unix_ms: f64, lat: f64, lon: f64) -> f64 {
    let jd = julian_day(unix_ms);
    let (ra, dec) = sun_equatorial(jd);
    alt_az(ra, dec, local_sidereal(jd, lon), lat * DEG).0 / DEG
}

/// Sun (RA, Dec) in radians. Astronomical Almanac low-precision formula.
pub fn sun_equatorial(jd: f64) -> (f64, f64) {
    let n = jd - 2_451_545.0;
    let l = (280.460 + 0.985_647_4 * n) * DEG;
    let g = (357.528 + 0.985_600_3 * n) * DEG;
    let lambda = l + (1.915 * g.sin() + 0.020 * (2.0 * g).sin()) * DEG;
    let eps = (23.439 - 0.000_000_4 * n) * DEG;
    let ra = (eps.cos() * lambda.sin()).atan2(lambda.cos()).rem_euclid(TAU);
    let dec = (eps.sin() * lambda.sin()).asin();
    (ra, dec)
}

/// Blackbody colour temperature → linear RGB in 0..1 (Tanner Helland's fit, converted from sRGB).
pub fn kelvin_to_rgb(k: f64) -> [f64; 3] {
    let t = k.clamp(1000.0, 40000.0) / 100.0;
    let r = if t <= 66.0 { 255.0 } else { 329.698_727_446 * (t - 60.0).powf(-0.133_204_759_2) };
    let g = if t <= 66.0 {
        99.470_802_586_1 * t.ln() - 161.119_568_166_1
    } else {
        288.122_169_528_3 * (t - 60.0).powf(-0.075_514_849_2)
    };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.517_731_223_1 * (t - 10.0).ln() - 305.044_792_730_7
    };
    let lin = |c: f64| {
        let c = (c / 255.0).clamp(0.0, 1.0);
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    [lin(r), lin(g), lin(b)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn gmst_at_j2000() {
        // 2000-01-01T12:00:00Z
        let jd = julian_day(946_728_000_000.0);
        assert!(close(jd, 2_451_545.0, 1e-9));
        assert!(close(gmst(jd) / DEG, 280.460_618_37, 1e-6));
    }

    #[test]
    fn polaris_altitude_is_latitude() {
        let (ra, dec) = ((2.0 + 31.0 / 60.0 + 49.0 / 3600.0) * 15.0 * DEG, 89.264 * DEG);
        for lat in [55.68_f64, 40.0, 10.0] {
            for hour in 0..24 {
                let ms = 1_700_000_000_000.0 + hour as f64 * 3_600_000.0;
                let lst = local_sidereal(julian_day(ms), 12.57);
                let (alt, az) = alt_az(ra, dec, lst, lat * DEG);
                assert!(close(alt / DEG, lat, 0.75), "lat {lat}: alt {}", alt / DEG);
                assert!(az / DEG < 2.0 || az / DEG > 358.0, "az {}", az / DEG);
            }
        }
    }

    #[test]
    fn meridian_transit() {
        // A star on the meridian sits due south at altitude 90 − φ + δ.
        let (phi, dec, lst) = (55.0 * DEG, 10.0 * DEG, 1.234);
        let (alt, az) = alt_az(lst, dec, lst, phi);
        assert!(close(alt / DEG, 45.0, 1e-9));
        assert!(close(az / DEG, 180.0, 1e-9));
        // Six hours later it has moved to the west (az > 180°).
        let (_, az) = alt_az(lst, dec, lst + PI / 2.0, phi);
        assert!(az / DEG > 180.0 && az / DEG < 360.0);
    }

    #[test]
    fn horizon_outline_points_are_on_the_horizon() {
        let lat = 55.68;
        let phi = lat * DEG;
        let pts = horizon_outline(lat, 64);
        for (i, xz) in pts.chunks_exact(2).enumerate() {
            let h = TAU * i as f64 / 64.0;
            let r = (xz[0] as f64).hypot(xz[1] as f64);
            let p = r * (PI - phi) / PLATE_FILL;
            let (alt, _) = alt_az(0.0, PI / 2.0 - p, h, phi);
            assert!(close(alt / DEG, 0.0, 0.01), "i {i}: alt {}", alt / DEG);
        }
        // The south point sits on the plate edge, the north point at the pole's altitude.
        assert!(close(pts[1] as f64, PLATE_FILL, 1e-6));
    }

    #[test]
    fn plate_and_dome_agree_on_meridian_direction() {
        let lst = 2.0;
        let (x, z) = plate_xy(lst, 0.0, lst, 55.0 * DEG);
        assert!(x.abs() < 1e-9 && z > 0.0);
        let (alt, az) = alt_az(lst, 0.0, lst, 55.0 * DEG);
        let v = horizon_to_xyz(alt, az);
        assert!(v[0].abs() < 1e-6 && v[2] > 0.0);
    }

    #[test]
    fn sun_is_low_at_winter_midnight_and_high_at_summer_noon() {
        // Copenhagen. 2024-12-21 23:00 UTC is around local midnight.
        assert!(sun_altitude(1_734_822_000_000.0, 55.68, 12.57) < -50.0);
        // 2024-06-21 11:10 UTC is around local solar noon: 90 − 55.68 + 23.44 ≈ 57.8°.
        assert!(close(sun_altitude(1_718_968_200_000.0, 55.68, 12.57), 57.8, 0.6));
    }

    #[test]
    fn colours_run_warm_to_cool() {
        let cool = kelvin_to_rgb(3000.0);
        let hot = kelvin_to_rgb(15000.0);
        assert!(cool[0] > cool[2] && hot[2] > hot[0]);
    }

    #[test]
    fn catalog_parse() {
        let mut b = Vec::new();
        b.extend_from_slice(&1.5f32.to_le_bytes());
        b.extend_from_slice(&(-0.25f32).to_le_bytes());
        b.extend_from_slice(&(-146i16).to_le_bytes());
        b.extend_from_slice(&9940u16.to_le_bytes());
        let s = Sky::parse(&b).unwrap();
        assert_eq!(s.len(), 1);
        assert!((s.mag[0] + 1.46).abs() < 1e-6);
        assert!(Sky::parse(&b[..11]).is_none());
    }
}
