import { t } from "../strings.da";
import { h } from "./dom";

/** The passphrase prompt under the planisphere. The input only reports its length to the scene. */
export class LockUI {
  readonly el: HTMLFormElement;
  private input: HTMLInputElement;
  private status: HTMLParagraphElement;
  private button: HTMLButtonElement;
  onLength: (n: number) => void = () => {};
  onSubmit: (pass: string) => void = () => {};

  constructor(root: HTMLElement) {
    this.input = h("input", {
      class: "lock__input",
      attrs: {
        id: "key",
        type: "password",
        autocomplete: "off",
        autocapitalize: "off",
        autocorrect: "off",
        spellcheck: "false",
        enterkeyhint: "go",
        "aria-describedby": "lock-status",
      },
    });
    this.button = h("button", { class: "lock__go", attrs: { type: "submit", "aria-label": t.open } });
    this.button.append(arrow());
    this.status = h("p", { class: "lock__status", attrs: { id: "lock-status", "aria-live": "polite" } });
    this.el = h(
      "form",
      { class: "lock", attrs: { autocomplete: "off" } },
      h("label", { class: "lock__prompt", text: t.prompt, attrs: { for: "key" } }),
      h("div", { class: "lock__field" }, this.input, this.button),
      this.status,
    );
    this.input.addEventListener("input", () => {
      this.onLength([...this.input.value].length);
      if (this.status.dataset.kind === "wrong") this.say("");
    });
    this.el.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.input.value.trim()) this.onSubmit(this.input.value);
    });
    root.append(this.el);
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
    this.input.value = "";
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

  /** Remove the prompt, and the passphrase with it. */
  leave(): void {
    this.input.value = "";
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
