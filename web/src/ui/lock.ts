import { t } from "../strings.da";
import { h } from "./dom";

/**
 * The prompt under the planisphere. Two modes:
 * - one code ("Hvad er vores nøgle?"), typed hidden;
 * - a quiz: the questions from the public lock.json, one at a time; the answers together are the key.
 * The scene only ever learns the length of what is typed.
 */
export class LockUI {
  readonly el: HTMLFormElement;
  private input: HTMLInputElement;
  private label: HTMLLabelElement;
  private step: HTMLSpanElement;
  private status: HTMLParagraphElement;
  private button: HTMLButtonElement;
  private answers: string[];
  private index = 0;
  onLength: (n: number) => void = () => {};
  onSubmit: (key: string | string[]) => void = () => {};

  constructor(
    root: HTMLElement,
    private questions: string[] = [],
  ) {
    const quiz = questions.length > 0;
    this.answers = questions.map(() => "");
    this.input = h("input", {
      class: "lock__input",
      attrs: {
        id: "key",
        type: quiz ? "text" : "password",
        autocomplete: "off",
        autocapitalize: "off",
        autocorrect: "off",
        spellcheck: "false",
        enterkeyhint: quiz ? "next" : "go",
        "aria-describedby": "lock-status",
      },
    });
    this.button = h("button", { class: "lock__go", attrs: { type: "submit", "aria-label": t.open } });
    this.button.append(arrow());
    this.label = h("label", { class: "lock__prompt", text: quiz ? questions[0] : t.prompt, attrs: { for: "key" } });
    this.step = h("span", { class: "lock__step" });
    this.status = h("p", { class: "lock__status", attrs: { id: "lock-status", "aria-live": "polite" } });
    this.el = h(
      "form",
      { class: `lock${quiz ? " lock--quiz" : ""}`, attrs: { autocomplete: "off" } },
      quiz ? this.step : null,
      this.label,
      h("div", { class: "lock__field" }, this.input, this.button),
      this.status,
    );
    this.input.addEventListener("input", () => {
      if (quiz) this.answers[this.index] = this.input.value;
      this.onLength(quiz ? this.answers.reduce((n, a) => n + [...a].length, 0) : [...this.input.value].length);
      if (this.status.dataset.kind === "wrong") this.say("");
    });
    this.el.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!this.input.value.trim()) return;
      if (!quiz) return this.onSubmit(this.input.value);
      this.answers[this.index] = this.input.value;
      if (this.index < this.questions.length - 1) this.goTo(this.index + 1);
      else this.onSubmit([...this.answers]);
    });
    if (quiz) this.goTo(0);
    root.append(this.el);
  }

  /** Show question i, with her earlier answer to it (if any) ready to edit. */
  private goTo(i: number): void {
    this.index = i;
    this.label.textContent = this.questions[i];
    this.step.textContent = t.quizStep(i + 1, this.questions.length);
    this.input.value = this.answers[i];
    this.button.setAttribute("aria-label", i < this.questions.length - 1 ? t.quizNext : t.open);
    this.label.classList.remove("is-new");
    void this.label.offsetWidth;
    this.label.classList.add("is-new");
    if (document.activeElement === this.input || i > 0) this.input.focus();
  }

  show(focus = true): void {
    this.el.classList.add("is-shown");
    if (focus && matchMedia("(pointer: fine)").matches) setTimeout(() => this.input.focus(), 600);
  }

  busy(on: boolean): void {
    this.input.disabled = on;
    this.button.disabled = on;
    this.el.classList.toggle("is-busy", on);
    if (on) this.say(t.deriving, "busy");
  }

  wrong(): void {
    this.busy(false);
    if (this.questions.length) {
      this.goTo(0); // keep her answers: usually only one is a little off
    } else {
      this.input.value = "";
    }
    this.say(t.wrong, "wrong");
    this.el.classList.remove("is-shaking");
    void this.el.offsetWidth;
    this.el.classList.add("is-shaking");
    this.input.focus();
  }

  say(text: string, kind = ""): void {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }

  /** Remove the prompt, and what was typed with it. */
  leave(): void {
    this.input.value = "";
    this.answers.fill("");
    this.input.blur();
    this.el.classList.remove("is-shown");
    this.el.classList.add("is-leaving");
    setTimeout(() => this.el.remove(), 900);
  }
}

function arrow(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M5 12h13M13 6l6 6-6 6");
  svg.append(p);
  return svg;
}
