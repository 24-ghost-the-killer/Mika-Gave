// Main-thread instance of the wasm core: sky math, springs and geometry.
// (The crypto worker loads its own instance; the data key never exists on this thread.)
import init from "./wasm/gift_wasm.js";

export * from "./wasm/gift_wasm.js";

let memory: WebAssembly.Memory | null = null;

export async function loadWasm(): Promise<void> {
  memory = (await init()).memory;
}

/** Zero-copy Float32Array view into wasm memory. Re-create it when memory grows (the buffer detaches). */
export function f32View(ptr: number, len: number): Float32Array {
  if (!memory) throw new Error("wasm not loaded");
  return new Float32Array(memory.buffer, ptr, len);
}
