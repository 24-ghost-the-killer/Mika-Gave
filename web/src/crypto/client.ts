import type { Door, Manifest } from "../manifest";

export type DoorResult = { status: "locked"; opens_ms: number } | { status: "open"; door: Door };
import type { Request } from "./worker";

/** Request without its id, distributed over the union. */
type Body<T> = T extends unknown ? Omit<T, "id"> : never;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Promise wrapper around the crypto worker. */
export class CryptoClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "vault" });
  private seq = 0;
  private pending = new Map<number, Pending>();
  private photos = new Map<string, Promise<string>>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (!p) return;
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "worker failed"));
      this.pending.clear();
    };
  }

  private call<T>(msg: Body<Request>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }

  async hasPassphrase(): Promise<boolean> {
    return (await this.call<{ hasPassphrase: boolean }>({ op: "hello" })).hasPassphrase;
  }

  async unlockLink(token: string): Promise<Manifest | null> {
    const r = await this.call<{ ok: boolean; manifest?: Manifest }>({ op: "link", token });
    return r.ok ? r.manifest! : null;
  }

  async unlockPassphrase(pass: string): Promise<Manifest | null> {
    const r = await this.call<{ ok: boolean; manifest?: Manifest }>({ op: "pass", pass });
    return r.ok ? r.manifest! : null;
  }

  async unlockQuiz(answers: string[]): Promise<Manifest | null> {
    const r = await this.call<{ ok: boolean; manifest?: Manifest }>({ op: "quiz", answers });
    return r.ok ? r.manifest! : null;
  }

  /** An advent door: its content if the server has released that day's secret, else when it opens. */
  async door(day: number, blob: string): Promise<DoorResult> {
    const r = await this.call<{ locked?: boolean; opens_ms?: number; door?: Door }>({ op: "door", day, blob });
    return r.locked ? { status: "locked", opens_ms: r.opens_ms! } : { status: "open", door: r.door! };
  }

  /** Object URL of a door's photo (sealed under the day key). */
  doorPhoto(day: number, id: string): Promise<string> {
    let p = this.photos.get(id);
    if (!p) {
      p = this.call<{ bytes?: Uint8Array }>({ op: "doorPhoto", day, blob: id }).then(({ bytes }) => {
        if (!bytes) throw new Error("door still locked");
        return URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
      });
      p.catch(() => this.photos.delete(id));
      this.photos.set(id, p);
    }
    return p;
  }

  /** Object URL of a decrypted photo. Cached, so repeat visits are instant. */
  photo(id: string): Promise<string> {
    let p = this.photos.get(id);
    if (!p) {
      p = this.call<{ bytes: Uint8Array }>({ op: "open", blob: id }).then(({ bytes }) =>
        URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" })),
      );
      p.catch(() => this.photos.delete(id));
      this.photos.set(id, p);
    }
    return p;
  }
}
