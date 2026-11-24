//! `seal`: turns the plaintext gift (content/gift.toml + photos) into ciphertext the site can serve.
//!
//! ```text
//! cargo run -p seal --release -- content web/public/v
//! ```
//!
//! * Asks twice for the passphrase (hidden input) and estimates its strength.
//! * Keeps the link token in `content/.link-token`, so re-sealing keeps the same private link.
//! * Re-encodes photos (≤ 1600 px, JPEG q85, EXIF orientation applied). Every byte of EXIF and GPS
//!   metadata is dropped, because only pixels are written back.
//! * Writes `header.bin`, `m.bin` and one random-named `.bin` per photo, then removes stale `.bin` files.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use clap::Parser;
use gift_crypto::{DataKey, Header, KdfParams, DEFAULT_BUCKET, MANIFEST_ID};
use image::{DynamicImage, ImageDecoder, ImageReader};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Parser)]
#[command(about = "Seal the gift: encrypt content/ into web/public/v/")]
struct Args {
    /// Content folder containing gift.toml
    content: PathBuf,
    /// Output folder (served publicly; receives ciphertext only)
    out: PathBuf,
    /// Skip the passphrase slot: the private link becomes the only way in
    #[arg(long)]
    no_passphrase: bool,
    /// Issue a new link token. The old link stops working
    #[arg(long)]
    rotate_link: bool,
    /// Argon2id memory in MiB
    #[arg(long, default_value_t = 64)]
    kdf_mib: u32,
    /// Argon2id passes
    #[arg(long, default_value_t = 3)]
    kdf_t: u32,
    /// Longest photo edge in pixels
    #[arg(long, default_value_t = 1600)]
    max_px: u32,
}

// ---------- gift.toml (input) ----------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Gift {
    recipient: String,
    domain: String,
    sky: SkyIn,
    #[serde(default)]
    intro: Option<Intro>,
    #[serde(default, rename = "memory")]
    memories: Vec<MemoryIn>,
    letter: Letter,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkyIn {
    /// RFC 3339 with offset, e.g. "2023-08-12T23:40:00+02:00"
    when: String,
    lat: f64,
    lon: f64,
    #[serde(default)]
    place: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Intro {
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryIn {
    #[serde(default)]
    date: String,
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    photo: Option<PathBuf>,
    /// Optional placement in the sky (degrees). Left out, the app arranges memories in an arc.
    #[serde(default)]
    alt: Option<f64>,
    #[serde(default)]
    az: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Letter {
    #[serde(default)]
    title: String,
    body: String,
    #[serde(default)]
    signature: String,
}

// ---------- manifest (encrypted output) ----------

#[derive(Serialize)]
struct Manifest {
    v: u32,
    recipient: String,
    sky: SkyOut,
    intro: Option<Intro>,
    memories: Vec<MemoryOut>,
    letter: Letter,
}

#[derive(Serialize)]
struct SkyOut {
    when_ms: f64,
    /// UTC offset of `when` in minutes, so the app shows the moment in its own local time.
    utc_offset_min: i32,
    lat: f64,
    lon: f64,
    place: String,
}

#[derive(Serialize)]
struct MemoryOut {
    date: String,
    title: String,
    text: String,
    photo: Option<PhotoRef>,
    alt: Option<f64>,
    az: Option<f64>,
}

#[derive(Serialize)]
struct PhotoRef {
    id: String,
    w: u32,
    h: u32,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let gift_path = args.content.join("gift.toml");
    let gift: Gift = toml::from_str(&fs::read_to_string(&gift_path).with_context(|| format!("reading {}", gift_path.display()))?)
        .with_context(|| format!("parsing {}", gift_path.display()))?;
    validate(&gift)?;

    let mut rng = OsRng;
    let dek = DataKey::generate(&mut rng);
    let mut slots = Vec::new();

    // Link slot: reuse the stored token, so the link she already has keeps working.
    let token_path = args.content.join(".link-token");
    let stored = if args.rotate_link { None } else { fs::read_to_string(&token_path).ok().map(|s| s.trim().to_owned()) };
    let (link_slot, token) = dek.link_slot(stored.as_deref(), &mut rng).context("link token in content/.link-token is malformed (use --rotate-link)")?;
    slots.push(link_slot);
    if stored.as_deref() != Some(token.as_str()) {
        write_private(&token_path, token.as_bytes())?;
    }

    // Passphrase slot.
    let pass = if args.no_passphrase { None } else { read_passphrase(&gift)? };
    if let Some(pass) = pass {
        let kdf = KdfParams { m_kib: args.kdf_mib * 1024, t: args.kdf_t, p: 1 };
        eprintln!("Deriving key (Argon2id, {} MiB, t={})…", args.kdf_mib, args.kdf_t);
        slots.push(dek.passphrase_slot(&pass, kdf, &mut rng).context("invalid KDF parameters")?);
    }

    // Write the ciphertext; stale files are swept afterwards.
    fs::create_dir_all(&args.out)?;
    let mut written: Vec<String> = Vec::new();
    let mut put = |name: String, bytes: &[u8]| -> Result<()> {
        fs::write(args.out.join(&name), bytes)?;
        written.push(name);
        Ok(())
    };

    let mut memories = Vec::with_capacity(gift.memories.len());
    for (i, m) in gift.memories.iter().enumerate() {
        let photo = match &m.photo {
            Some(rel) => {
                let path = args.content.join(rel);
                let (jpeg, w, h) = prepare_photo(&path, args.max_px).with_context(|| format!("photo for memory {} ({})", i + 1, path.display()))?;
                let id = random_id(&mut rng);
                put(format!("{id}.bin"), &dek.seal(&id, &jpeg, DEFAULT_BUCKET, &mut rng))?;
                eprintln!("  photo {:>2}: {w}×{h}, {} KiB", i + 1, jpeg.len() / 1024);
                Some(PhotoRef { id, w, h })
            }
            None => None,
        };
        memories.push(MemoryOut { date: m.date.clone(), title: m.title.clone(), text: m.text.clone(), photo, alt: m.alt, az: m.az });
    }

    let (when_ms, utc_offset_min) = parse_when(&gift.sky.when)?;
    let manifest = Manifest {
        v: 1,
        recipient: gift.recipient.clone(),
        sky: SkyOut { when_ms, utc_offset_min, lat: gift.sky.lat, lon: gift.sky.lon, place: gift.sky.place.clone() },
        intro: gift.intro.clone(),
        memories,
        letter: gift.letter.clone(),
    };
    let json = Zeroizing::new(serde_json::to_vec(&manifest)?);
    put(format!("{MANIFEST_ID}.bin"), &dek.seal(MANIFEST_ID, &json, DEFAULT_BUCKET, &mut rng))?;
    put("header.bin".into(), &Header { slots }.to_bytes())?;

    // Remove ciphertext left over from earlier seals.
    for entry in fs::read_dir(&args.out)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.ends_with(".bin") && !written.contains(&name) {
            fs::remove_file(args.out.join(&name))?;
        }
    }

    let total: u64 = written.iter().filter_map(|n| fs::metadata(args.out.join(n)).ok()).map(|m| m.len()).sum();
    eprintln!("\nSealed {} files ({} KiB) into {}", written.len(), total / 1024, args.out.display());
    eprintln!("Private link (keep it secret, it opens the gift without the passphrase):\n");
    println!("https://{}/#{}", gift.domain.trim_end_matches('/'), token);
    Ok(())
}

fn validate(g: &Gift) -> Result<()> {
    ensure!(!g.recipient.trim().is_empty(), "recipient is empty");
    ensure!(!g.domain.contains("://") && !g.domain.contains('/'), "domain should be a bare host name like gift.example.com");
    ensure!((-90.0..=90.0).contains(&g.sky.lat) && (-180.0..=180.0).contains(&g.sky.lon), "sky.lat/lon out of range");
    ensure!(!g.letter.body.trim().is_empty(), "letter.body is empty");
    for (i, m) in g.memories.iter().enumerate() {
        if let Some(alt) = m.alt {
            ensure!((5.0..=88.0).contains(&alt), "memory {}: alt should be 5–88°", i + 1);
        }
        ensure!(m.alt.is_some() == m.az.is_some(), "memory {}: set both alt and az, or neither", i + 1);
    }
    Ok(())
}

fn parse_when(s: &str) -> Result<(f64, i32)> {
    let t = time::OffsetDateTime::parse(s.trim(), &time::format_description::well_known::Rfc3339)
        .with_context(|| format!("sky.when {s:?}: use RFC 3339 with offset, e.g. 2023-08-12T23:40:00+02:00"))?;
    Ok(((t.unix_timestamp_nanos() / 1_000_000) as f64, t.offset().whole_minutes() as i32))
}

/// `None` means link-only: the user pressed Enter without typing a passphrase.
fn read_passphrase(g: &Gift) -> Result<Option<Zeroizing<String>>> {
    // For scripted builds only. Prefer the prompt: env vars end up in shell history and process listings.
    let pass = if let Ok(p) = std::env::var("SEAL_PASSPHRASE") {
        eprintln!("Using passphrase from SEAL_PASSPHRASE.");
        Zeroizing::new(p)
    } else {
        eprintln!(
            "\nChoose the code she will type to open the gift: a short sentence only you two would say works best.\n\
             Nothing shows while you type. Press Enter on an empty line for no code (the private link opens it).\n"
        );
        let a = Zeroizing::new(rpassword::prompt_password("Passphrase: ")?);
        if a.trim().is_empty() {
            eprintln!("No passphrase: the private link printed below will be the only way in.");
            return Ok(None);
        }
        let b = Zeroizing::new(rpassword::prompt_password("Again:      ")?);
        if gift_crypto::normalize_passphrase(&a) != gift_crypto::normalize_passphrase(&b) {
            bail!("the two passphrases differ; run it again");
        }
        a
    };
    let norm = gift_crypto::normalize_passphrase(&pass);
    ensure!(
        norm.chars().count() >= 4,
        "that code is too short: use at least 4 characters (a short sentence is best), or press Enter on an empty line for link-only"
    );

    // zxcvbn knows the obvious guesses; feed it the personal facts an attacker could also try.
    let hints: Vec<&str> = [g.recipient.as_str(), g.sky.place.as_str(), g.sky.when.as_str()]
        .into_iter()
        .chain(g.memories.iter().map(|m| m.date.as_str()))
        .collect();
    let est = zxcvbn::zxcvbn(&norm, &hints);
    let log10 = est.guesses_log10();
    // Argon2id at 64 MiB: assume a determined attacker with GPUs manages ~10⁴ guesses/s.
    let secs = 10f64.powf(log10) / 2.0 / 1e4;
    eprintln!("Passphrase strength: ~{:.0} bits; offline cracking at 10⁴ guesses/s ≈ {}", log10 * 10f64.log2(), human(secs));
    if log10 < 10.0 {
        eprintln!(
            "⚠  WARNING: weak passphrase. The ciphertext is public, so anyone with the URL can try guesses offline.\n   \
             Use a longer sentence only the two of you would say, or run with --no-passphrase and use the link."
        );
    }
    Ok(Some(pass))
}

fn human(s: f64) -> String {
    match s {
        s if s < 60.0 => "under a minute".into(),
        s if s < 3600.0 => format!("{:.0} minutes", s / 60.0),
        s if s < 86_400.0 => format!("{:.0} hours", s / 3600.0),
        s if s < 3.15e7 => format!("{:.0} days", s / 86_400.0),
        s if s < 3.15e10 => format!("{:.0} years", s / 3.15e7),
        _ => "millennia".into(),
    }
}

/// Decode, apply EXIF orientation, downscale and re-encode as JPEG. Only pixels are written,
/// so no EXIF, GPS, maker notes or thumbnails survive.
fn prepare_photo(path: &Path, max_px: u32) -> Result<(Vec<u8>, u32, u32)> {
    let mut decoder = ImageReader::open(path)?.with_guessed_format()?.into_decoder().context("unsupported image (HEIC? export it as JPEG first)")?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    if img.width().max(img.height()) > max_px {
        img = img.resize(max_px, max_px, image::imageops::FilterType::Lanczos3);
    }
    let rgb = img.to_rgb8();
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&rgb)?;
    Ok((out.into_inner(), rgb.width(), rgb.height()))
}

fn random_id(rng: &mut impl RngCore) -> String {
    let mut b = [0u8; 9];
    rng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
