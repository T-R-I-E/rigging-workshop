// Main-thread driver for the rustoda Web Worker. One worker shared across
// all callers; if a call times out the worker is terminated and lazily
// respawned on the next call. The client serializes requests through a
// FIFO queue so multiple concurrent callers don't trample each other on
// the single in-flight slot.

let _worker = null
let _queue = []    // [{ msg, timeoutMs, resolve }, ...]
let _busy = false

function spawn() {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
}

function get_worker() {
  if (!_worker) _worker = spawn()
  return _worker
}

function pump() {
  if (_busy) return
  let job = _queue.shift()
  if (!job) return
  _busy = true
  let worker = get_worker()
  let settled = false
  let cleanup = () => {
    clearTimeout(timer)
    worker.removeEventListener('message', onMsg)
    worker.removeEventListener('error', onErr)
  }
  let finish = (v) => {
    if (settled) return
    settled = true
    cleanup()
    _busy = false
    job.resolve(v)
    pump()
  }
  let onMsg = (e) => {
    if (e.data.ok) finish({ ok: true, result: e.data.result })
    else           finish({ ok: false, error: e.data.error })
  }
  let onErr = (e) => finish({ ok: false, error: e.message || 'worker error' })
  let timer = setTimeout(() => {
    // Worker may be stuck inside synchronous wasm — terminate it. Next
    // call spawns a fresh one (wasm init pays a small one-time cost).
    worker.terminate()
    _worker = null
    finish({ ok: false, error: `wasm timeout (${job.timeoutMs}ms)`, timeout: true })
  }, job.timeoutMs)
  worker.addEventListener('message', onMsg)
  worker.addEventListener('error', onErr)
  worker.postMessage(job.msg)
}

// Public API: returns { ok, result | error, timeout? }. Result is the
// JSON string the wasm produces; caller JSON.parses it.
export function check_via_worker({ bytes, cork, twist }, timeoutMs = 10000) {
  return new Promise(resolve => {
    _queue.push({ msg: { bytes, cork, twist }, timeoutMs, resolve })
    pump()
  })
}
