use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use sha2::{Digest, Sha256};

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

pub fn new_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    if passphrase.is_empty() {
        return Err("passphrase is empty".into());
    }
    if salt.len() != SALT_LEN {
        return Err("invalid salt".into());
    }
    // Interactive-ish params: fine for a personal vault unlock.
    let params = Params::new(19_456, 2, 1, Some(KEY_LEN)).map_err(|err| err.to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|err| format!("derive key: {err}"))?;
    Ok(key)
}

pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|err| err.to_string())?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|err| format!("encrypt: {err}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn decrypt(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() <= NONCE_LEN {
        return Err("ciphertext too short".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|err| err.to_string())?;
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "decrypt failed — wrong passphrase or corrupt data".into())
}

pub fn content_hash(body: &str) -> String {
    let digest = Sha256::digest(body.as_bytes());
    hex::encode(digest)
}

pub fn note_id(path: &str) -> String {
    let digest = Sha256::digest(path.as_bytes());
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_hash() {
        let salt = new_salt();
        let key = derive_key("test-pass", &salt).unwrap();
        let blob = encrypt(&key, b"hello vault").unwrap();
        assert_eq!(decrypt(&key, &blob).unwrap(), b"hello vault");
        assert!(decrypt(&key, &blob[..8]).is_err());
        assert_eq!(content_hash("a"), content_hash("a"));
        assert_ne!(content_hash("a"), content_hash("b"));
        assert_eq!(note_id("Daily/a.md").len(), 64);
    }
}
