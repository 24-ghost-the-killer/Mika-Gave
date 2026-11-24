/** Every word the visitor sees. Nothing personal lives here; that is all in the encrypted manifest. */
export const t = {
  prompt: "Hvad er vores nøgle?",
  open: "Åbn",
  deriving: "Stjernerne drejer…",
  wrong: "Ikke helt…",
  linkOnly: "Denne gave åbnes med et særligt link.",
  linkStale: "Linket passer ikke længere – prøv nøglen.",
  hint: "Træk for at se dig omkring · tryk på en stjerne",
  begin: "Se stjernerne",
  next: "Næste",
  prev: "Forrige",
  close: "Luk",
  readLetter: "Læs brevet",
  letter: "Brevet",
  backToSky: "Tilbage til himlen",
  photoFailed: "Billedet kunne ikke åbnes.",
  noWebgl: "Din browser kan ikke vise stjernehimlen, men alt det vigtige er her.",
  failed: "Noget gik galt. Prøv at genindlæse siden.",
  contextLost: "Grafikken gik i stå. Genindlæs siden for at fortsætte.",
};

const MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
export const MONTHS_SHORT = ["JAN", "FEB", "MAR", "APR", "MAJ", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEC"];

/** "12. august 2023 · kl. 23.40" in the moment's own local time (independent of the viewer's zone). */
export function formatMoment(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · kl. ${hh}.${mm}`;
}
