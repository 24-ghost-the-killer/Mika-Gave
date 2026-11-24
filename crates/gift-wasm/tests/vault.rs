//! Proves the wasm build of the vault opens what the native `seal` CLI produced
//! (same format, same KDF, same normalisation). Run: `wasm-pack test --node crates/gift-wasm`.
#![cfg(target_arch = "wasm32")]

use gift_wasm::vault::{header_has_passphrase, Vault};
use wasm_bindgen_test::*;

const HEADER: &[u8] = include_bytes!("fixture/header.bin");
const MANIFEST: &[u8] = include_bytes!("fixture/m.bin");
const TOKEN: &str = include_str!("fixture/src/.link-token");

fn letter_ok(v: &Vault) {
    let json = String::from_utf8(v.open("m", MANIFEST).unwrap()).unwrap();
    assert!(json.contains("\"recipient\":\"Testperson\""), "{json}");
    assert!(json.contains("Hej fra fixture."));
}

#[wasm_bindgen_test]
fn opens_with_link_token() {
    assert!(header_has_passphrase(HEADER));
    letter_ok(&Vault::unlock_link(HEADER, &format!("#{}", TOKEN.trim())).unwrap());
}

#[wasm_bindgen_test]
fn opens_with_sloppy_passphrase() {
    // Different case, spacing and a smart quote-free variant: normalisation must match the native side.
    letter_ok(&Vault::unlock_passphrase(HEADER, "  Under STJERNERNE   ved broen ").unwrap());
}

#[wasm_bindgen_test]
fn rejects_wrong_keys() {
    assert!(Vault::unlock_passphrase(HEADER, "under stjernerne").is_err());
    assert!(Vault::unlock_link(HEADER, "AAAAAAAAAAAAAAAAAAAAAA").is_err());
}
