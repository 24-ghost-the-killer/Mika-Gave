/// <reference lib="webworker" />
// Crypto worker: the only place the data key lives. It fetches ciphertext, derives keys
// (Argon2id takes seconds; that work stays off the render thread) and posts back plaintext.
import init, { Vault, headerHasPassphrase } from "../wasm/gift_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

export type Request =
  | { id: number; op: "hello" }
  | { id: number; op: "link"; token: string }
  | { id: number; op: "pass"; pass: string }
  | { id: number; op: "quiz"; answers: string[] }
  | { id: number; op: "open"; blob: string }
  | { id: number; op: "door"; day: number; blob: string }
  | { id: number; op: "doorPhoto"; day: number; blob: string };

/** Day secrets already released by the server (they never change once out). */
const daySecrets = new Map<number, Uint8Array>();

/** The day secret for a door, or the time it opens if the server says "not yet". */
async function daySecret(day: number): Promise<Uint8Array | { opens_ms: number }> {
  const known = daySecrets.get(day);
  if (known) return known;
  const r = await fetch(`/advent/${day}`, { cache: "no-store", credentials: "omit" });
  if (r.status === 403) return (await r.json()) as { opens_ms: number };
  if (!r.ok) throw new Error(`door ${day}: ${r.status}`);
  const { secret } = (await r.json()) as { secret: string };
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("bad day secret");
  const bytes = new Uint8Array(secret.match(/../g)!.map((h) => parseInt(h, 16)));
  daySecrets.set(day, bytes);
  return bytes;
}

let vault: Vault | null = null;

async function bin(name: string): Promise<Uint8Array> {
  const r = await fetch(`/v/${name}.bin`, { cache: "no-cache", credentials: "omit" });
  if (!r.ok) throw new Error(`fetch ${name}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const ready = init().then(() => bin("header"));

function reply(id: number, body: object, transfer: Transferable[] = []) {
  self.postMessage({ id, ...body }, transfer);
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const m = e.data;
  try {
    const header = await ready;
    switch (m.op) {
      case "hello":
        return reply(m.id, { hasPassphrase: headerHasPassphrase(header) });
      case "link":
      case "pass":
      case "quiz": {
        vault?.free();
        vault = null;
        try {
          vault =
            m.op === "link"
              ? Vault.unlockLink(header, m.token)
              : m.op === "pass"
                ? Vault.unlockPassphrase(header, m.pass)
                : Vault.unlockQuiz(header, m.answers);
        } catch {
          return reply(m.id, { ok: false });
        }
        const json = new TextDecoder().decode(vault.open("m", await bin("m")));
        return reply(m.id, { ok: true, manifest: JSON.parse(json) });
      }
      case "open": {
        if (!vault) throw new Error("locked");
        if (!/^[0-9a-f]{18}$/.test(m.blob)) throw new Error("bad id");
        const bytes = vault.open(m.blob, await bin(m.blob));
        return reply(m.id, { bytes }, [bytes.buffer]);
      }
      case "door":
      case "doorPhoto": {
        if (!vault) throw new Error("locked");
        if (!/^[0-9a-f]{18}$/.test(m.blob) || !(m.day >= 1 && m.day <= 31)) throw new Error("bad door");
        const secret = await daySecret(m.day);
        if (!(secret instanceof Uint8Array)) return reply(m.id, { locked: true, opens_ms: secret.opens_ms });
        const bytes = vault.openDoor(m.blob, await bin(m.blob), secret);
        if (m.op === "doorPhoto") return reply(m.id, { bytes }, [bytes.buffer]);
        return reply(m.id, { door: JSON.parse(new TextDecoder().decode(bytes)) });
      }
    }
  } catch (err) {
    reply(m.id, { error: err instanceof Error ? err.message : String(err) });
  }
};
