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
  quizNext: "Næste spørgsmål",
  quizStep: (i: number, n: number) => `${i} / ${n}`,
  advent: "Julekalender",
  adventToday: "Dagens låge venter ✦",
  doorTitle: (day: number) => `${day}. december`,
  doorLocked: (day: number, opensMs: number) => `Låge ${day} åbner ${untilText(opensMs)}.`,
  doorFailed: "Lågen kunne ikke åbnes lige nu. Prøv igen om lidt.",
  herStarTitle: (name: string) => `${/[sxzSXZ]$/.test(name) ? `${name}'` : `${name}s`} stjerne`,
  herStarSub: (star: string, ly: number) => `${star} · ${String(Math.round(ly * 10) / 10).replace(".", ",")} lysår herfra`,
  herStarLight: (left: number, born: number) =>
    Math.abs(left - born) <= 1
      ? `Lyset, du ser fra den nu, forlod stjernen omkring ${born} – året du blev født. Det har været på vej mod dig hele dit liv.`
      : left > born
        ? `Lyset, du ser fra den nu, forlod stjernen omkring ${left}, da du var ${left - born} år.`
        : `Lyset, du ser fra den nu, forlod stjernen omkring ${left}, ${born - left} år før du blev født.`,
};

/** "om 3 dage", "i morgen", "i nat kl. 00.00", "om 2 timer". */
function untilText(ms: number): string {
  const diff = ms - Date.now();
  const hours = diff / 3_600_000;
  if (hours <= 1) return "om lidt";
  if (hours < 12) return `om ${Math.ceil(hours)} timer`;
  const opens = new Date(ms);
  const today = new Date();
  const dayDiff = Math.round((new Date(opens.getFullYear(), opens.getMonth(), opens.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  if (dayDiff <= 1) return "i nat kl. 00.00";
  return `om ${dayDiff} dage`;
}

const MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
export const MONTHS_SHORT = ["JAN", "FEB", "MAR", "APR", "MAJ", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEC"];

/** "12. august 2023 · kl. 23.40" in the moment's own local time (independent of the viewer's zone). */
export function formatMoment(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · kl. ${hh}.${mm}`;
}
