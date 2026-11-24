//! `STJ1` payload format, shared by the native `seal` CLI and the browser vault (wasm).
//!
//! The format works like LUKS:
//! * A random 256-bit **data key** (DEK) encrypts every blob with AES-256-GCM.
//! * The DEK is stored several times in the public `header.bin`, each copy wrapped by a
//!   key-encryption key (KEK) taken from one *slot*:
//!   - **Link slot**: a 128-bit random token carried in the URL fragment. KEK = HKDF-SHA256.
//!   - **Passphrase slot**: a human passphrase. KEK = Argon2id with the parameters stored in the slot.
//!
//! ```text
//! header.bin = "STJ1" | ver:u8 | n:u8 | n × slot
//! slot       = kind:u8 | salt[16] | m_kib:u32le | t:u32le | p:u32le | nonce[12] | AESGCM(KEK, DEK)[48]
//!              (the first 29 bytes are the AAD, so tampering with the params breaks unwrap)
//! blob       = nonce[12] | AESGCM(DEK, len:u32le | data | zero padding to bucket, aad = "STJ1/blob/" + id)
//! ```
//!
//! This module needs no randomness when decrypting, so it builds for `wasm32-unknown-unknown`
//! without `getrandom`. Sealing takes an injected `CryptoRng`.
#![forbid(unsafe_code)]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use rand_core::{CryptoRng, RngCore};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 4] = b"STJ1";
pub const VERSION: u8 = 1;
pub const KEY_LEN: usize = 32;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const TOKEN_LEN: usize = 16;
/// Blobs are padded to a multiple of this, so file sizes say little about the content.
pub const DEFAULT_BUCKET: usize = 16 * 1024;
/// Blob id of the encrypted JSON manifest (`m.bin`).
pub const MANIFEST_ID: &str = "m";

const SLOT_AAD_LEN: usize = 1 + SALT_LEN + 12;
const WRAPPED_LEN: usize = KEY_LEN + TAG_LEN;
const SLOT_LEN: usize = SLOT_AAD_LEN + NONCE_LEN + WRAPPED_LEN;
const LINK_INFO: &[u8] = b"STJ1 link kek";
const BLOB_AAD_PREFIX: &[u8] = b"STJ1/blob/";

// Upper bounds accepted when parsing, so a malicious header cannot make a browser allocate gigabytes.
const MAX_M_KIB: u32 = 256 * 1024;
const MAX_T: u32 = 16;
const MAX_P: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// Header or blob is malformed.
    Format,
    /// No slot accepted the key (wrong passphrase or token).
    Unlock,
    /// A blob failed authentication (wrong key, wrong id or tampered).
    Decrypt,
    /// KDF parameters are out of range.
    Params,
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Error::Format => "malformed payload",
            Error::Unlock => "key not accepted",
            Error::Decrypt => "decryption failed",
            Error::Params => "invalid KDF parameters",
        })
    }
}

impl std::error::Error for Error {}

pub type Result<T> = core::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    /// 64 MiB, 3 passes, 1 lane: about 1 s in desktop wasm and 2–4 s on a phone.
    /// The unlock animation covers that wait.
    fn default() -> Self {
        Self { m_kib: 64 * 1024, t: 3, p: 1 }
    }
}

impl KdfParams {
    fn validate(&self) -> Result<()> {
        let ok = (1..=MAX_P).contains(&self.p)
            && (1..=MAX_T).contains(&self.t)
            && self.m_kib >= 8 * self.p
            && self.m_kib <= MAX_M_KIB;
        if ok { Ok(()) } else { Err(Error::Params) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SlotKind {
    Link = 1,
    Passphrase = 2,
}

#[derive(Clone)]
pub struct Slot {
    pub kind: SlotKind,
    salt: [u8; SALT_LEN],
    pub kdf: KdfParams,
    nonce: [u8; NONCE_LEN],
    wrapped: [u8; WRAPPED_LEN],
}

impl Slot {
    fn aad(&self) -> [u8; SLOT_AAD_LEN] {
        let mut a = [0u8; SLOT_AAD_LEN];
        a[0] = self.kind as u8;
        a[1..17].copy_from_slice(&self.salt);
        a[17..21].copy_from_slice(&self.kdf.m_kib.to_le_bytes());
        a[21..25].copy_from_slice(&self.kdf.t.to_le_bytes());
        a[25..29].copy_from_slice(&self.kdf.p.to_le_bytes());
        a
    }

    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.aad());
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.wrapped);
    }

    fn read(b: &[u8]) -> Result<Self> {
        debug_assert_eq!(b.len(), SLOT_LEN);
        let kind = match b[0] {
            1 => SlotKind::Link,
            2 => SlotKind::Passphrase,
            _ => return Err(Error::Format),
        };
        let u32_at = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        let kdf = KdfParams { m_kib: u32_at(17), t: u32_at(21), p: u32_at(25) };
        if kind == SlotKind::Passphrase {
            kdf.validate()?;
        }
        Ok(Slot {
            kind,
            salt: b[1..17].try_into().unwrap(),
            kdf,
            nonce: b[29..41].try_into().unwrap(),
            wrapped: b[41..89].try_into().unwrap(),
        })
    }

    fn unwrap_with(&self, kek: &[u8; KEY_LEN]) -> Result<DataKey> {
        let cipher = Aes256Gcm::new_from_slice(kek).map_err(|_| Error::Unlock)?;
        let aad = self.aad();
        let pt = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&self.nonce), Payload { msg: &self.wrapped, aad: &aad })
                .map_err(|_| Error::Unlock)?,
        );
        let mut k = Zeroizing::new([0u8; KEY_LEN]);
        k.copy_from_slice(&pt);
        Ok(DataKey(k))
    }
}

/// Public header (`header.bin`). Holds the wrapped copies of the data key.
#[derive(Clone)]
pub struct Header {
    pub slots: Vec<Slot>,
}

impl Header {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 6 || &bytes[..4] != MAGIC || bytes[4] != VERSION {
            return Err(Error::Format);
        }
        let n = bytes[5] as usize;
        let body = &bytes[6..];
        if n == 0 || body.len() != n * SLOT_LEN {
            return Err(Error::Format);
        }
        let slots = body.chunks_exact(SLOT_LEN).map(Slot::read).collect::<Result<Vec<_>>>()?;
        Ok(Header { slots })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(6 + self.slots.len() * SLOT_LEN);
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.push(self.slots.len() as u8);
        for s in &self.slots {
            s.write(&mut out);
        }
        out
    }

    pub fn has(&self, kind: SlotKind) -> bool {
        self.slots.iter().any(|s| s.kind == kind)
    }

    /// Unlock with the URL-fragment token. Fast, HKDF only.
    pub fn unlock_link(&self, token: &str) -> Result<DataKey> {
        let raw = decode_token(token)?;
        self.slots
            .iter()
            .filter(|s| s.kind == SlotKind::Link)
            .find_map(|s| s.unwrap_with(&link_kek(&raw, &s.salt)).ok())
            .ok_or(Error::Unlock)
    }

    /// Unlock with a passphrase. Runs Argon2id once per passphrase slot.
    pub fn unlock_passphrase(&self, passphrase: &str) -> Result<DataKey> {
        let norm = normalize_passphrase(passphrase);
        for s in self.slots.iter().filter(|s| s.kind == SlotKind::Passphrase) {
            let kek = passphrase_kek(&norm, &s.salt, s.kdf)?;
            if let Ok(k) = s.unwrap_with(&kek) {
                return Ok(k);
            }
        }
        Err(Error::Unlock)
    }
}

/// The content key. Zeroed on drop.
pub struct DataKey(Zeroizing<[u8; KEY_LEN]>);

impl DataKey {
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let mut k = Zeroizing::new([0u8; KEY_LEN]);
        rng.fill_bytes(&mut *k);
        DataKey(k)
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&*self.0).expect("32-byte key")
    }

    /// Wrap this key in a link slot. Returns the slot and the token to put in the URL.
    pub fn link_slot<R: RngCore + CryptoRng>(&self, token: Option<&str>, rng: &mut R) -> Result<(Slot, String)> {
        let raw: [u8; TOKEN_LEN] = match token {
            Some(t) => decode_token(t)?,
            None => {
                let mut r = [0u8; TOKEN_LEN];
                rng.fill_bytes(&mut r);
                r
            }
        };
        let mut salt = [0u8; SALT_LEN];
        rng.fill_bytes(&mut salt);
        let kek = link_kek(&raw, &salt);
        let slot = self.wrap(SlotKind::Link, salt, KdfParams { m_kib: 0, t: 0, p: 0 }, &kek, rng);
        Ok((slot, URL_SAFE_NO_PAD.encode(raw)))
    }

    /// Wrap this key in a passphrase slot (Argon2id).
    pub fn passphrase_slot<R: RngCore + CryptoRng>(&self, passphrase: &str, kdf: KdfParams, rng: &mut R) -> Result<Slot> {
        kdf.validate()?;
        let mut salt = [0u8; SALT_LEN];
        rng.fill_bytes(&mut salt);
        let kek = passphrase_kek(&normalize_passphrase(passphrase), &salt, kdf)?;
        Ok(self.wrap(SlotKind::Passphrase, salt, kdf, &kek, rng))
    }

    fn wrap<R: RngCore + CryptoRng>(&self, kind: SlotKind, salt: [u8; SALT_LEN], kdf: KdfParams, kek: &[u8; KEY_LEN], rng: &mut R) -> Slot {
        let mut nonce = [0u8; NONCE_LEN];
        rng.fill_bytes(&mut nonce);
        let mut slot = Slot { kind, salt, kdf, nonce, wrapped: [0u8; WRAPPED_LEN] };
        let aad = slot.aad();
        let ct = Aes256Gcm::new_from_slice(kek)
            .expect("32-byte key")
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &*self.0, aad: &aad })
            .expect("encrypt");
        slot.wrapped.copy_from_slice(&ct);
        slot
    }

    /// Encrypt one blob. `bucket` is the padding granularity in bytes (0 = no padding).
    pub fn seal<R: RngCore + CryptoRng>(&self, id: &str, data: &[u8], bucket: usize, rng: &mut R) -> Vec<u8> {
        let len = u32::try_from(data.len()).expect("blob < 4 GiB");
        let mut padded = Vec::with_capacity(4 + data.len());
        padded.extend_from_slice(&len.to_le_bytes());
        padded.extend_from_slice(data);
        if bucket > 0 {
            // Leave room for nonce + tag so the *file* lands on the bucket boundary.
            let file_len = NONCE_LEN + padded.len() + TAG_LEN;
            let target = file_len.div_ceil(bucket) * bucket;
            padded.resize(target - NONCE_LEN - TAG_LEN, 0);
        }
        let mut nonce = [0u8; NONCE_LEN];
        rng.fill_bytes(&mut nonce);
        let aad = blob_aad(id);
        let ct = self
            .cipher()
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &padded, aad: &aad })
            .expect("encrypt");
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    /// Decrypt and unpad one blob.
    pub fn open(&self, id: &str, blob: &[u8]) -> Result<Vec<u8>> {
        if blob.len() < NONCE_LEN + TAG_LEN + 4 {
            return Err(Error::Format);
        }
        let (nonce, ct) = blob.split_at(NONCE_LEN);
        let aad = blob_aad(id);
        let mut pt = self
            .cipher()
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &aad })
            .map_err(|_| Error::Decrypt)?;
        let len = u32::from_le_bytes(pt[..4].try_into().unwrap()) as usize;
        if 4 + len > pt.len() {
            return Err(Error::Format);
        }
        pt.truncate(4 + len);
        pt.drain(..4);
        Ok(pt)
    }
}

fn blob_aad(id: &str) -> Vec<u8> {
    let mut a = Vec::with_capacity(BLOB_AAD_PREFIX.len() + id.len());
    a.extend_from_slice(BLOB_AAD_PREFIX);
    a.extend_from_slice(id.as_bytes());
    a
}

fn decode_token(token: &str) -> Result<[u8; TOKEN_LEN]> {
    let t = token.trim().trim_start_matches('#');
    let v = URL_SAFE_NO_PAD.decode(t).map_err(|_| Error::Unlock)?;
    v.try_into().map_err(|_| Error::Unlock)
}

fn link_kek(token: &[u8; TOKEN_LEN], salt: &[u8; SALT_LEN]) -> Zeroizing<[u8; KEY_LEN]> {
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    Hkdf::<Sha256>::new(Some(salt), token)
        .expand(LINK_INFO, &mut *kek)
        .expect("32 bytes is a valid HKDF length");
    kek
}

fn passphrase_kek(norm: &str, salt: &[u8; SALT_LEN], kdf: KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    kdf.validate()?;
    let params = Params::new(kdf.m_kib, kdf.t, kdf.p, Some(KEY_LEN)).map_err(|_| Error::Params)?;
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(norm.as_bytes(), salt, &mut *kek)
        .map_err(|_| Error::Params)?;
    Ok(kek)
}

/// Normalise a passphrase so small typing differences between devices still match:
/// * NFKC Unicode normalisation (composed æøå, full-width forms)
/// * typographic quotes and dashes from phone keyboards become ASCII `'` `"` `-`
/// * whitespace trimmed and collapsed to single spaces
/// * lowercased
pub fn normalize_passphrase(s: &str) -> Zeroizing<String> {
    let mapped: Zeroizing<String> = Zeroizing::new(
        s.nfkc()
            .map(|c| match c {
                '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{02BC}' | '\u{00B4}' | '`' => '\'',
                '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{00AB}' | '\u{00BB}' => '"',
                '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
                c => c,
            })
            .collect(),
    );
    let mut out = String::with_capacity(mapped.len());
    for (i, w) in mapped.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(w);
    }
    Zeroizing::new(out.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_chacha::rand_core::SeedableRng;
    use rand_chacha::ChaCha20Rng;

    const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };

    fn rng() -> ChaCha20Rng {
        ChaCha20Rng::seed_from_u64(7)
    }

    fn sealed() -> (Vec<u8>, String, Vec<u8>) {
        let mut r = rng();
        let dek = DataKey::generate(&mut r);
        let (link, token) = dek.link_slot(None, &mut r).unwrap();
        let pass = dek.passphrase_slot("Under Stjernerne", FAST, &mut r).unwrap();
        let header = Header { slots: vec![link, pass] }.to_bytes();
        let blob = dek.seal(MANIFEST_ID, b"hello stars", DEFAULT_BUCKET, &mut r);
        (header, token, blob)
    }

    #[test]
    fn roundtrip_link_and_passphrase() {
        let (h, token, blob) = sealed();
        let h = Header::parse(&h).unwrap();
        assert_eq!(h.unlock_link(&token).unwrap().open(MANIFEST_ID, &blob).unwrap(), b"hello stars");
        assert_eq!(h.unlock_link(&format!("#{token}")).unwrap().open(MANIFEST_ID, &blob).unwrap(), b"hello stars");
        let k = h.unlock_passphrase("  under   STJERNERNE ").unwrap();
        assert_eq!(k.open(MANIFEST_ID, &blob).unwrap(), b"hello stars");
    }

    #[test]
    fn wrong_keys_fail() {
        let (h, token, _) = sealed();
        let h = Header::parse(&h).unwrap();
        assert_eq!(h.unlock_passphrase("under stjernen").err(), Some(Error::Unlock));
        let mut bad = token.into_bytes();
        bad[0] = if bad[0] == b'A' { b'B' } else { b'A' };
        assert_eq!(h.unlock_link(std::str::from_utf8(&bad).unwrap()).err(), Some(Error::Unlock));
        assert_eq!(h.unlock_link("not-a-token").err(), Some(Error::Unlock));
    }

    #[test]
    fn tampering_is_detected() {
        let (h, token, mut blob) = sealed();
        let hp = Header::parse(&h).unwrap();
        let k = hp.unlock_link(&token).unwrap();
        // Wrong id (blob swapped between files)
        assert_eq!(k.open("other", &blob).err(), Some(Error::Decrypt));
        // Flipped ciphertext bit
        blob[40] ^= 1;
        assert_eq!(k.open(MANIFEST_ID, &blob).err(), Some(Error::Decrypt));
        // Tampered KDF params in the header (bound as AAD)
        let mut h2 = h.clone();
        let pass_slot_off = 6 + SLOT_LEN;
        h2[pass_slot_off + 21] ^= 2; // t: 1 → 3, still valid, but no longer matches the AAD
        let hp2 = Header::parse(&h2).unwrap();
        assert_eq!(hp2.unlock_passphrase("under stjernerne").err(), Some(Error::Unlock));
        // t: 1 → 0 is rejected before any KDF work.
        let mut h3 = h.clone();
        h3[pass_slot_off + 21] ^= 1;
        assert_eq!(Header::parse(&h3).err(), Some(Error::Params));
    }

    #[test]
    fn padding_hits_bucket_boundaries() {
        let mut r = rng();
        let dek = DataKey::generate(&mut r);
        for n in [0usize, 1, 100, DEFAULT_BUCKET - 32, DEFAULT_BUCKET, 3 * DEFAULT_BUCKET + 5] {
            let data = vec![0xAB; n];
            let blob = dek.seal("x", &data, DEFAULT_BUCKET, &mut r);
            assert_eq!(blob.len() % DEFAULT_BUCKET, 0, "n={n}");
            assert_eq!(dek.open("x", &blob).unwrap(), data);
        }
    }

    #[test]
    fn header_rejects_garbage_and_huge_params() {
        assert_eq!(Header::parse(b"nope").err(), Some(Error::Format));
        let (mut h, ..) = sealed();
        h.push(0);
        assert_eq!(Header::parse(&h).err(), Some(Error::Format));
        let (mut h, ..) = sealed();
        let off = 6 + SLOT_LEN + 17;
        h[off..off + 4].copy_from_slice(&(u32::MAX).to_le_bytes());
        assert_eq!(Header::parse(&h).err(), Some(Error::Params));
    }

    #[test]
    fn normalisation() {
        assert_eq!(&*normalize_passphrase("  Vi  så\tStjerner "), "vi så stjerner");
        assert_eq!(&*normalize_passphrase("Mika\u{2019}s – sang"), "mika's - sang");
        // Decomposed å (a + ring) equals composed å
        assert_eq!(normalize_passphrase("a\u{030A}"), normalize_passphrase("\u{00E5}"));
    }
}
