// Compile / decompile bridge. As of the JS port, both run in-browser via the
// sibling trdl repo (imported through the trdl/ symlink). The Clojure server
// is no longer required at runtime.

import { parse_trdl_string, trdl_to_spec } from './trdl/trdl.js'
import { build, entity_hashes }            from './trdl/compile.js'
import { decompile as toda_decompile,
         emit_jsonl }                      from './trdl/decompile.js'

export async function compile(trdl_text) {
  let entities = parse_trdl_string(trdl_text)
  let spec     = trdl_to_spec(entities)
  let { bytes, twists, corkline_h } = await build(spec)
  let lineHashes = entity_hashes(entities, twists)
  return { bytes: bytes.buffer, lineHashes, corkline: corkline_h }
}

export async function decompile(toda_buf, corkline_hint = null) {
  let entities = await toda_decompile(toda_buf, 'rig', corkline_hint)
  return emit_jsonl(entities)
}
