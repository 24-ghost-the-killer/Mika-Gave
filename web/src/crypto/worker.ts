/// <reference lib="webworker" />
// Crypto worker: the only place the data key lives. It fetches ciphertext, derives keys
// (Argon2id takes seconds; that work stays off the render thread) and posts back plaintext.
import init, { Vault, headerHasPassphrase } from "../wasm/gift_wasm.js";

declare const self: DedicatedWorkerGlobalScope;

export type Request =
  | { id: number; op: "hello" }
  | { id: number; op: "link"; token: string }
  | { id: number; op: "pass"; pass: string }
  | { id: number; op: "open"; blob: string };

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
      case "pass": {
        vault?.free();
        vault = null;
        try {
          vault = m.op === "link" ? Vault.unlockLink(header, m.token) : Vault.unlockPassphrase(header, m.pass);
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
    }
  } catch (err) {
    reply(m.id, { error: err instanceof Error ? err.message : String(err) });
  }
};
