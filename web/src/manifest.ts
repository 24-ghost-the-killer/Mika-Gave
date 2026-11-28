/** The decrypted manifest (written by `seal`, see crates/seal/src/main.rs). */
export interface Manifest {
  v: 1;
  recipient: string;
  sky: { when_ms: number; utc_offset_min: number; lat: number; lon: number; place: string };
  intro: { title: string; text: string } | null;
  memories: Memory[];
  letter: { title: string; body: string; signature: string };
  her_star: HerStar | null;
  advent: Advent | null;
}

/** A real star with her name (chosen in the app from public/near-stars.json). */
export interface HerStar {
  name: string;
  born: number;
  star: string | null;
  text: string;
}

/** Advent doors: where and when. Each door's content is a separate blob under its day key. */
export interface Advent {
  year: number;
  doors: { day: number; id: string; opens_ms: number }[];
}

/** Inside a door blob. */
export interface Door {
  day: number;
  title: string;
  text: string;
  photo: { id: string; w: number; h: number } | null;
}

export interface Memory {
  date: string;
  title: string;
  text: string;
  photo: { id: string; w: number; h: number } | null;
  alt: number | null;
  az: number | null;
}
