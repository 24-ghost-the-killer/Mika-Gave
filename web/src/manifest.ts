/** The decrypted manifest (written by `seal`, see crates/seal/src/main.rs). */
export interface Manifest {
  v: 1;
  recipient: string;
  sky: { when_ms: number; utc_offset_min: number; lat: number; lon: number; place: string };
  intro: { title: string; text: string } | null;
  memories: Memory[];
  letter: { title: string; body: string; signature: string };
}

export interface Memory {
  date: string;
  title: string;
  text: string;
  photo: { id: string; w: number; h: number } | null;
  alt: number | null;
  az: number | null;
}
