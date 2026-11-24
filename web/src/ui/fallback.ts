import type { Manifest } from "../manifest";
import { t } from "../strings.da";
import { formatMoment } from "../strings.da";
import { memoryBody, type PhotoLoader } from "./card";
import { h, paragraphs } from "./dom";

/** No WebGL: the same content as a calm, scrolling page. */
export function renderFallback(root: HTMLElement, m: Manifest, photo: PhotoLoader): void {
  document.body.classList.add("is-fallback");
  const page = h(
    "article",
    { class: "fallback" },
    h("p", { class: "fallback__note", text: t.noWebgl }),
    h("p", { class: "intro__to", text: m.recipient }),
    m.intro?.title ? h("h1", { class: "intro__title", text: m.intro.title }) : null,
    ...(m.intro?.text ? paragraphs(m.intro.text, "intro__text") : []),
    h("p", { class: "caption is-shown" }, h("span", { text: [m.sky.place, formatMoment(m.sky.when_ms, m.sky.utc_offset_min)].filter(Boolean).join(" · ") })),
  );
  for (const mem of m.memories) page.append(h("section", { class: "fallback__memory" }, memoryBody(mem, photo)));
  const letter = h("section", { class: "fallback__letter letter__paper" });
  if (m.letter.title) letter.append(h("h1", { class: "letter__title", text: m.letter.title }));
  letter.append(...paragraphs(m.letter.body, "letter__p"));
  if (m.letter.signature) letter.append(h("p", { class: "letter__sig", text: m.letter.signature }));
  page.append(letter);
  root.append(page);
}
