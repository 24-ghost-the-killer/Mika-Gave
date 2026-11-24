import type { Memory } from "../manifest";
import { t } from "../strings.da";
import { h, paragraphs } from "./dom";

export type PhotoLoader = (id: string) => Promise<string>;

/** Builds the inside of a memory card: photo (decrypted on demand), date, title, text. */
export function memoryBody(m: Memory, photo: PhotoLoader): HTMLElement {
  const body = h("div", { class: "card__body" });
  if (m.photo) {
    const img = h("img", { class: "card__img", attrs: { alt: "", decoding: "async", draggable: "false" } });
    const fig = h("figure", { class: "card__photo is-loading" }, img);
    fig.style.setProperty("--ratio", `${m.photo.w} / ${m.photo.h}`);
    fig.style.setProperty("--portrait", m.photo.h > m.photo.w ? "1" : "0");
    photo(m.photo.id)
      .then((url) => {
        img.src = url;
        return img.decode().catch(() => {});
      })
      .then(() => fig.classList.remove("is-loading"))
      .catch(() => {
        fig.classList.remove("is-loading");
        fig.classList.add("is-failed");
        fig.append(h("figcaption", { text: t.photoFailed }));
      });
    body.append(fig);
  }
  if (m.date) body.append(h("p", { class: "card__date", text: m.date }));
  body.append(h("h2", { class: "card__title", text: m.title }));
  if (m.text) body.append(...paragraphs(m.text, "card__text"));
  return body;
}

/** The memory card. It is a side panel on wide screens and a bottom sheet on phones. */
export class Card {
  readonly el: HTMLElement;
  private content: HTMLElement;
  private counter: HTMLElement;
  private prev: HTMLButtonElement;
  private next: HTMLButtonElement;
  onPrev: () => void = () => {};
  onNext: () => void = () => {};
  onClose: () => void = () => {};
  onLetter: () => void = () => {};
  private isLast = false;

  constructor(root: HTMLElement) {
    this.content = h("div", { class: "card__content" });
    this.counter = h("span", { class: "card__count" });
    this.prev = h("button", { class: "card__nav-btn", text: `‹ ${t.prev}`, attrs: { type: "button" } });
    this.next = h("button", { class: "card__nav-btn card__nav-btn--next", text: `${t.next} ›`, attrs: { type: "button" } });
    const close = h("button", { class: "card__close", text: "×", attrs: { type: "button", "aria-label": t.close } });
    this.el = h(
      "article",
      { class: "card", attrs: { role: "dialog", "aria-modal": "false", "aria-live": "polite" } },
      close,
      this.content,
      h("nav", { class: "card__nav" }, this.prev, this.counter, this.next),
    );
    close.addEventListener("click", () => this.onClose());
    this.prev.addEventListener("click", () => this.onPrev());
    this.next.addEventListener("click", () => (this.isLast ? this.onLetter() : this.onNext()));
    for (const ev of ["pointerdown", "wheel", "touchstart"]) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    root.append(this.el);
  }

  open(m: Memory, index: number, count: number, photo: PhotoLoader): void {
    const body = memoryBody(m, photo);
    body.classList.add("is-entering");
    this.content.replaceChildren(body);
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("is-entering")));
    this.counter.textContent = `${index + 1} / ${count}`;
    this.prev.disabled = index === 0;
    this.isLast = index === count - 1;
    this.next.textContent = this.isLast ? `${t.readLetter} ✦` : `${t.next} ›`;
    this.next.classList.toggle("is-letter", this.isLast);
    this.el.classList.add("is-shown");
    this.el.scrollTop = 0;
  }

  close(): void {
    this.el.classList.remove("is-shown");
  }

  get isOpen(): boolean {
    return this.el.classList.contains("is-shown");
  }
}
