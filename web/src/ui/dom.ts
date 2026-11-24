/** Tiny DOM builder. Text always goes in via textContent, never as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text != null) el.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Split text into paragraphs on blank lines; single newlines become <br>. */
export function paragraphs(text: string, cls?: string): HTMLParagraphElement[] {
  return text
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const p = h("p", { class: cls });
      block.split("\n").forEach((line, i) => {
        if (i) p.append(h("br"));
        p.append(line.trim());
      });
      return p;
    });
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Toggle a class on the next frame, so CSS transitions run from the initial state. */
export function show(el: HTMLElement, on = true): void {
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.toggle("is-shown", on)));
}
