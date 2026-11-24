import type { Manifest } from "../manifest";
import { t } from "../strings.da";
import { h, paragraphs } from "./dom";

/** The letter. It comes last: full screen, set in Fraunces, paragraphs arriving one by one. */
export class Letter {
  readonly el: HTMLElement;
  onClose: () => void = () => {};

  constructor(root: HTMLElement, m: Manifest) {
    const paper = h("div", { class: "letter__paper" });
    if (m.letter.title) paper.append(h("h1", { class: "letter__title", text: m.letter.title }));
    const ps = paragraphs(m.letter.body, "letter__p");
    ps.forEach((p, i) => p.style.setProperty("--i", String(i + 1)));
    paper.append(...ps);
    if (m.letter.signature) {
      const sig = h("p", { class: "letter__sig", text: m.letter.signature });
      sig.style.setProperty("--i", String(ps.length + 1.5));
      paper.append(sig);
    }
    const back = h("button", { class: "letter__back", text: t.backToSky, attrs: { type: "button" } });
    back.addEventListener("click", () => this.onClose());
    this.el = h("section", { class: "letter", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t.letter } }, paper, back);
    this.el.addEventListener("keydown", (e) => e.key === "Escape" && this.onClose());
    for (const ev of ["pointerdown", "wheel", "touchstart"]) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    root.append(this.el);
  }

  open(): void {
    this.el.classList.add("is-shown");
    this.el.scrollTop = 0;
    setTimeout(() => this.el.querySelector<HTMLButtonElement>(".letter__back")?.focus({ preventScroll: true }), 50);
  }

  close(): void {
    this.el.classList.remove("is-shown");
  }

  get isOpen(): boolean {
    return this.el.classList.contains("is-shown");
  }
}
