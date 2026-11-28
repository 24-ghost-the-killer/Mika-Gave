import type { Manifest } from "../manifest";
import { formatMoment, t } from "../strings.da";
import { h, paragraphs } from "./dom";

/** Intro words over the sky, a quiet caption with place and time, a hint, and the letter button. */
export class Overlay {
  private intro: HTMLElement;
  private caption: HTMLElement;
  private hint: HTMLElement;
  readonly letterButton: HTMLButtonElement;
  readonly adventButton: HTMLButtonElement;
  private toastEl: HTMLElement;
  private toastTimer = 0;
  onBegin: () => void = () => {};
  onLetter: () => void = () => {};
  onAdvent: () => void = () => {};

  constructor(root: HTMLElement, m: Manifest) {
    const begin = h("button", { class: "intro__begin", text: t.begin, attrs: { type: "button" } });
    begin.addEventListener("click", () => this.onBegin());
    this.intro = h(
      "section",
      { class: "intro" },
      h("p", { class: "intro__to", text: m.recipient }),
      m.intro?.title ? h("h1", { class: "intro__title", text: m.intro.title }) : null,
      ...(m.intro?.text ? paragraphs(m.intro.text, "intro__text") : []),
      begin,
    );
    this.caption = h(
      "p",
      { class: "caption" },
      m.sky.place ? h("span", { class: "caption__place", text: m.sky.place }) : null,
      h("span", { class: "caption__when", text: formatMoment(m.sky.when_ms, m.sky.utc_offset_min) }),
    );
    this.hint = h("p", { class: "hint", text: t.hint });
    this.letterButton = h("button", { class: "letter-btn", text: `✦ ${t.letter}`, attrs: { type: "button" } });
    this.letterButton.addEventListener("click", () => this.onLetter());
    this.adventButton = h("button", { class: "advent-btn", text: `✦ ${t.advent}`, attrs: { type: "button" } });
    this.adventButton.addEventListener("click", () => this.onAdvent());
    this.toastEl = h("p", { class: "toast", attrs: { role: "status", "aria-live": "polite" } });
    root.append(this.intro, this.caption, this.hint, this.letterButton, this.adventButton, this.toastEl);
  }

  showAdventButton(fresh: boolean): void {
    this.adventButton.classList.add("is-shown");
    this.adventButton.classList.toggle("is-fresh", fresh);
  }

  /** A short message near the bottom that fades away by itself. */
  toast(text: string, ms = 3800): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("is-shown");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("is-shown"), ms);
  }

  showIntro(): void {
    this.intro.classList.add("is-shown");
    setTimeout(() => this.intro.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }), 1200);
  }

  hideIntro(): void {
    this.intro.classList.remove("is-shown");
    this.intro.classList.add("is-gone");
  }

  get introOpen(): boolean {
    return this.intro.classList.contains("is-shown");
  }

  showChrome(): void {
    this.caption.classList.add("is-shown");
    this.hint.classList.add("is-shown");
  }

  hideHint(): void {
    this.hint.classList.remove("is-shown");
  }

  showLetterButton(): void {
    this.letterButton.classList.add("is-shown");
  }

  /** Hide the caption and hint while a card or the letter is open, to keep things calm. */
  dim(on: boolean): void {
    this.caption.classList.toggle("is-dim", on);
    this.hint.classList.toggle("is-dim", on);
  }
}

/** A short message in the middle of the screen (link-only gifts, errors). */
export function notice(root: HTMLElement, text: string): HTMLElement {
  const el = h("p", { class: "notice", text });
  root.append(el);
  requestAnimationFrame(() => el.classList.add("is-shown"));
  return el;
}
