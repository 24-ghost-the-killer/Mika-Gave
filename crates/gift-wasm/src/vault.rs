//! The browser vault. It lives only inside the crypto Web Worker, so the data key never
//! reaches the main thread. Only decrypted blobs are posted back.

use gift_crypto::{DataKey, Header, SlotKind};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Vault {
    key: DataKey,
}

#[wasm_bindgen]
impl Vault {
    /// Unlock with the URL-fragment token (fast).
    #[wasm_bindgen(js_name = unlockLink)]
    pub fn unlock_link(header: &[u8], token: &str) -> Result<Vault, JsError> {
        let h = Header::parse(header).map_err(to_js)?;
        Ok(Vault { key: h.unlock_link(token).map_err(to_js)? })
    }

    /// Unlock with a passphrase (Argon2id; takes about 1–3 s).
    #[wasm_bindgen(js_name = unlockPassphrase)]
    pub fn unlock_passphrase(header: &[u8], passphrase: &str) -> Result<Vault, JsError> {
        let h = Header::parse(header).map_err(to_js)?;
        Ok(Vault { key: h.unlock_passphrase(passphrase).map_err(to_js)? })
    }

    /// Decrypt one blob. `id` is the file stem (the manifest is `"m"`).
    pub fn open(&self, id: &str, blob: &[u8]) -> Result<Vec<u8>, JsError> {
        self.key.open(id, blob).map_err(to_js)
    }
}

#[wasm_bindgen(js_name = headerHasPassphrase)]
pub fn header_has_passphrase(header: &[u8]) -> bool {
    Header::parse(header).map(|h| h.has(SlotKind::Passphrase)).unwrap_or(false)
}

fn to_js(e: gift_crypto::Error) -> JsError {
    JsError::new(&e.to_string())
}
