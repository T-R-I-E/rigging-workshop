// rustoda check_rig runs in a Web Worker so the main thread can
// worker.terminate() if it hangs. The wasm is synchronous; without a
// separate thread, any infinite loop in Rust freezes the whole page.
//
// Wire: client posts { bytes, cork, twist }, worker replies
// { ok: true, result } or { ok: false, error }. One in-flight request
// at a time — the client serializes calls.

import * as mod from './rigcheck.js'

const ready = mod.default()

self.onmessage = async (e) => {
  await ready
  try {
    const { bytes, cork, twist } = e.data
    const result = mod.check_rig(bytes, cork, twist)
    self.postMessage({ ok: true, result })
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || String(err) })
  }
}
