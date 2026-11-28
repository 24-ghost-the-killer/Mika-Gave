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
//! * `[lock]` questions: asks for the answers instead of one code; only the questions are public
//!   (`lock.json`), the answers together form the key.
//! * `[advent]` doors: each door is sealed under its own day key (data key + a random day secret).
//!   The secrets go to `--advent-keys` (default `web/advent-keys/`), outside the public folder; the
//!   server hands each one out only from midnight on its date.

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
    /// Where the advent day secrets go (served by the server only on their dates).
    /// Default: `advent-keys/` next to the public folder's parent, i.e. web/advent-keys
    #[arg(long)]
    advent_keys: Option<PathBuf>,
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
    #[serde(default)]
    lock: Option<LockIn>,
    #[serde(default)]
    her_star: Option<HerStar>,
    #[serde(default)]
    advent: Option<AdventIn>,
}

/// Quiz lock: she answers these instead of typing one code. The questions are public.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LockIn {
    questions: Vec<String>,
}

/// A real star with her name: the one whose light left it around the year she was born.
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct HerStar {
    name: String,
    born: i32,
    /// Optional: pick the star yourself by name (e.g. "Vega"); otherwise the app chooses.
    #[serde(default)]
    star: Option<String>,
    /// Optional extra words shown with the star.
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdventIn {
    /// The December the doors belong to. Default: this year.
    #[serde(default)]
    year: Option<i32>,
    /// When "midnight" is. Default +01:00 (Danish winter time).
    #[serde(default = "default_offset")]
    utc_offset: String,
    #[serde(default, rename = "door")]
    doors: Vec<DoorIn>,
}

fn default_offset() -> String {
    "+01:00".into()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DoorIn {
    day: u8,
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    photo: Option<PathBuf>,
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
    her_star: Option<HerStar>,
    advent: Option<AdventOut>,
}

#[derive(Serialize)]
struct AdventOut {
    year: i32,
    doors: Vec<DoorRef>,
}

/// In the manifest: only where a door is and when it opens. Its content is in its own blob,
/// sealed under the day key.
#[derive(Serialize)]
struct DoorRef {
    day: u8,
    id: String,
    opens_ms: i64,
}

/// Inside a door blob.
#[derive(Serialize)]
struct DoorOut {
    day: u8,
    title: String,
    text: String,
    photo: Option<PhotoRef>,
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

    // Passphrase slot: a quiz (answers combined) or one code.
    let pass = match (&gift.lock, args.no_passphrase) {
        (_, true) => None,
        (Some(lock), false) => read_answers(&gift, lock)?,
        (None, false) => read_passphrase(&gift)?,
    };
    if let Some(pass) = pass.as_ref() {
        let kdf = KdfParams { m_kib: args.kdf_mib * 1024, t: args.kdf_t, p: 1 };
        eprintln!("Deriving key (Argon2id, {} MiB, t={})…", args.kdf_mib, args.kdf_t);
        slots.push(dek.passphrase_slot(pass, kdf, &mut rng).context("invalid KDF parameters")?);
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

    // Advent doors: each under its own day key; the day secrets go to the server's folder.
    let keys_dir = args.advent_keys.clone().unwrap_or_else(|| {
        args.out.parent().and_then(Path::parent).unwrap_or(Path::new(".")).join("advent-keys")
    });
    let mut advent = None;
    let mut key_files: Vec<String> = Vec::new();
    if let Some(a) = gift.advent.as_ref().filter(|a| !a.doors.is_empty()) {
        let year = a.year.unwrap_or_else(|| time::OffsetDateTime::now_utc().year());
        let offset = parse_offset(&a.utc_offset)?;
        fs::create_dir_all(&keys_dir)?;
        let mut doors = Vec::with_capacity(a.doors.len());
        for d in &a.doors {
            let mut secret = Zeroizing::new([0u8; gift_crypto::DAY_SECRET_LEN]);
            rng.fill_bytes(&mut *secret);
            let day_key = dek.with_secret(&*secret)?;
            let photo = match &d.photo {
                Some(rel) => {
                    let path = args.content.join(rel);
                    let (jpeg, w, h) = prepare_photo(&path, args.max_px).with_context(|| format!("photo for advent door {} ({})", d.day, path.display()))?;
                    let id = random_id(&mut rng);
                    put(format!("{id}.bin"), &day_key.seal(&id, &jpeg, DEFAULT_BUCKET, &mut rng))?;
                    Some(PhotoRef { id, w, h })
                }
                None => None,
            };
            let door = DoorOut { day: d.day, title: d.title.clone(), text: d.text.clone(), photo };
            let id = random_id(&mut rng);
            let json = Zeroizing::new(serde_json::to_vec(&door)?);
            put(format!("{id}.bin"), &day_key.seal(&id, &json, DEFAULT_BUCKET, &mut rng))?;

            let opens_ms = door_opens_ms(year, d.day, offset)?;
            let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
            let name = format!("{}.json", d.day);
            fs::write(keys_dir.join(&name), format!("{{\"opens_ms\":{opens_ms},\"secret\":\"{hex}\"}}\n"))?;
            key_files.push(name);
            doors.push(DoorRef { day: d.day, id, opens_ms });
        }
        doors.sort_by_key(|d| d.day);
        eprintln!("  advent: {} doors for December {year}; day keys in {}", doors.len(), keys_dir.display());
        advent = Some(AdventOut { year, doors });
    }
    // Day keys from an earlier seal would no longer match anything; remove them.
    if keys_dir.is_dir() {
        for entry in fs::read_dir(&keys_dir)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") && !key_files.contains(&name) {
                fs::remove_file(keys_dir.join(&name))?;
            }
        }
    }

    // The quiz questions are public: she reads them before anything is unlocked.
    let lock_path = args.out.join("lock.json");
    match (&gift.lock, pass.is_some()) {
        (Some(lock), true) => fs::write(&lock_path, serde_json::to_vec(&serde_json::json!({ "questions": lock.questions }))?)?,
        _ => {
            let _ = fs::remove_file(&lock_path);
        }
    }

    let (when_ms, utc_offset_min) = parse_when(&gift.sky.when)?;
    let manifest = Manifest {
        v: 1,
        recipient: gift.recipient.clone(),
        sky: SkyOut { when_ms, utc_offset_min, lat: gift.sky.lat, lon: gift.sky.lon, place: gift.sky.place.clone() },
        intro: gift.intro.clone(),
        memories,
        letter: gift.letter.clone(),
        her_star: gift.her_star.clone(),
        advent,
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
    if let Some(lock) = &g.lock {
        ensure!((1..=5).contains(&lock.questions.len()), "lock.questions: use 1 to 5 questions");
        ensure!(lock.questions.iter().all(|q| !q.trim().is_empty()), "lock.questions: a question is empty");
    }
    if let Some(h) = &g.her_star {
        let this_year = time::OffsetDateTime::now_utc().year();
        ensure!(!h.name.trim().is_empty(), "her_star.name is empty");
        ensure!((1900..=this_year).contains(&h.born), "her_star.born should be a year like 1998");
    }
    if let Some(a) = &g.advent {
        let mut seen = std::collections::HashSet::new();
        for d in &a.doors {
            ensure!((1..=24).contains(&d.day), "advent door day {} should be 1–24 (one per December day until Christmas Eve)", d.day);
            ensure!(seen.insert(d.day), "advent: two doors for day {}", d.day);
            ensure!(!d.title.trim().is_empty(), "advent door {}: title is empty", d.day);
        }
        parse_offset(&a.utc_offset)?;
    }
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

fn parse_offset(s: &str) -> Result<time::UtcOffset> {
    let bad = || anyhow::anyhow!("advent.utc_offset {s:?}: use e.g. \"+01:00\"");
    let t = s.trim();
    let (sign, rest) = match t.as_bytes().first() {
        Some(b'+') => (1i8, &t[1..]),
        Some(b'-') => (-1i8, &t[1..]),
        _ => return Err(bad()),
    };
    let (h, m) = rest.split_once(':').ok_or_else(bad)?;
    let (h, m): (i8, i8) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    time::UtcOffset::from_hms(sign * h, sign * m, 0).map_err(|_| bad())
}

/// Midnight at the start of `day` December `year`, at `offset`, in Unix milliseconds.
fn door_opens_ms(year: i32, day: u8, offset: time::UtcOffset) -> Result<i64> {
    let date = time::Date::from_calendar_date(year, time::Month::December, day).with_context(|| format!("no {day} December {year}"))?;
    let t = time::PrimitiveDateTime::new(date, time::Time::MIDNIGHT).assume_offset(offset);
    Ok((t.unix_timestamp_nanos() / 1_000_000) as i64)
}

/// Quiz: ask each question (answers are visible while typing, so typos can be seen). `None` means
/// link-only: Enter on the first answer.
fn read_answers(g: &Gift, lock: &LockIn) -> Result<Option<Zeroizing<String>>> {
    let answers: Vec<Zeroizing<String>> = if let Ok(a) = std::env::var("SEAL_ANSWERS") {
        eprintln!("Using answers from SEAL_ANSWERS.");
        a.split('|').map(|x| Zeroizing::new(x.to_owned())).collect()
    } else {
        eprintln!(
            "\nThe gift opens when she answers these {} questions. Type the answers she would give.\n\
             Capitals, spaces and a full stop at the end don't matter. Enter on an empty first answer\n\
             means no quiz (the private link opens it).\n",
            lock.questions.len()
        );
        let mut out = Vec::new();
        for (i, q) in lock.questions.iter().enumerate() {
            eprint!("{}. {q}\n   Svar: ", i + 1);
            let mut line = Zeroizing::new(String::new());
            std::io::stdin().read_line(&mut line)?;
            if i == 0 && line.trim().is_empty() {
                eprintln!("No quiz: the private link printed below will be the only way in.");
                return Ok(None);
            }
            ensure!(!line.trim().is_empty(), "answer {} is empty; run it again", i + 1);
            out.push(Zeroizing::new(line.trim().to_owned()));
        }
        out
    };
    ensure!(answers.len() == lock.questions.len(), "expected {} answers, got {}", lock.questions.len(), answers.len());
    let pass = gift_crypto::quiz_passphrase(&answers.iter().map(|a| a.as_str()).collect::<Vec<_>>());
    eprintln!("Her answers become: {} parts (forgiving about capitals, spaces and punctuation).", answers.len());
    check_strength(g, &pass, true);
    Ok(Some(pass))
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
    check_strength(g, &pass, false);
    Ok(Some(pass))
}

/// zxcvbn knows the obvious guesses; feed it the personal facts an attacker could also try.
fn check_strength(g: &Gift, pass: &str, quiz: bool) {
    let norm = gift_crypto::normalize_passphrase(pass);
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
        if quiz {
            eprintln!(
                "⚠  WARNING: these answers are easy to guess. The questions and the encrypted files are public, so\n   \
                 anyone with the URL can try answers offline. Use questions with longer, more personal answers,\n   \
                 or rely on the private link."
            );
        } else {
            eprintln!(
                "⚠  WARNING: weak passphrase. The ciphertext is public, so anyone with the URL can try guesses offline.\n   \
                 Use a longer sentence only the two of you would say, or run with --no-passphrase and use the link."
            );
        }
    }
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
