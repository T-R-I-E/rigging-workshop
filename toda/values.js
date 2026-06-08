// Bitstream-expression evaluator for TRDL utility functions.
// (Spec §"Symbols, other constants, and utility functions for raw data".)
//
// Public API:
//   parse_expr(text)           → AST node (throws on syntax errors)
//   evaluate(text, resolve_name?)        → Promise<Uint8Array>
//   evaluate_node(node, resolve_name?)   → Promise<Uint8Array>
//
// `resolve_name` is an optional callback that receives a bare-name token
// (anything that isn't a function call, `null`, or `unit`) and returns the
// bitstream that name refers to (entity reference resolution lives outside
// this module). If absent, bare names throw.
//
// Grammar (recursive-descent, left-associative `+`):
//   expr  := atom ('+' atom)*
//   atom  := func | name
//   func  := name '(' raw_arg | (arg (',' arg)*) ')'
//   arg   := expr
//   name  := [A-Za-z_][A-Za-z_0-9-]*
//
// Special cases per spec:
//   `null` and `unit` are constants (0x00 and 0xff).
//   `hex(...)`  and `base64(...)` take the raw text inside the parens
//   (sans whitespace) as a literal bitstream — the contents are NOT
//   parsed as expressions, so commas or `+` inside aren't significant.

import { sha256, hex_to_bytes, byte_concat } from './bytes.js'
import { SYMBOLS } from './symbols.js'

// ---- tokenizer ------------------------------------------------------------

function is_name_start(c) { return /[A-Za-z_]/.test(c) }
function is_name_part(c)  { return /[A-Za-z_0-9-]/.test(c) }

// Walk an identifier (possibly with `[N]` suffix) starting at `i`. Returns
// { name, end } where `name` includes any bracket-index suffix so that
// resolvers see `poptop[0]` as one token, not two.
function read_name(s, i) {
  let start = i
  if (!is_name_start(s[i])) throw new Error(`expected name at pos ${i}`)
  i++
  while (i < s.length && is_name_part(s[i])) i++
  // Optional [N] suffix — entity-reference shorthand. We accept it here so
  // the resolver sees the whole reference as one token.
  if (s[i] === '[') {
    let j = i + 1
    while (j < s.length && s[j] !== ']') j++
    if (s[j] !== ']') throw new Error(`unterminated [...] at pos ${i}`)
    i = j + 1
  }
  return { name: s.slice(start, i), end: i }
}

function skip_ws(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

// ---- parser ---------------------------------------------------------------

// Returns { node, end } where `end` is the index past the parsed expr.
function parse_expr_at(s, i) {
  let { node: left, end } = parse_atom(s, i)
  i = skip_ws(s, end)
  while (s[i] === '+') {
    i = skip_ws(s, i + 1)
    let { node: right, end: e2 } = parse_atom(s, i)
    if (left.tag === 'concat') left.parts.push(right)
    else left = { tag: 'concat', parts: [left, right] }
    i = skip_ws(s, e2)
  }
  return { node: left, end: i }
}

function parse_atom(s, i) {
  i = skip_ws(s, i)
  if (i >= s.length) throw new Error(`expected atom at pos ${i}`)
  // Numeric byte specifier (e.g. `0x41` as a hash algorithm). Tokenised
  // as a name so downstream functions can switch on it; not a general
  // expression atom — `0x41` is meaningless on its own as a bitstream.
  let hex_alg = /^0x[0-9a-fA-F]+/.exec(s.slice(i))
  if (hex_alg) {
    return { node: { tag: 'name', name: hex_alg[0] }, end: i + hex_alg[0].length }
  }
  let { name, end } = read_name(s, i)
  i = skip_ws(s, end)
  if (s[i] !== '(') {
    return { node: { tag: 'name', name }, end: i }
  }
  // Function call. hex() and base64() are special — their contents are
  // raw literals, not nested expressions.
  let open = i
  if (name === 'hex' || name === 'base64') {
    let close = find_matching_paren(s, open)
    let raw = s.slice(open + 1, close)
    return { node: { tag: 'literal', kind: name, raw }, end: close + 1 }
  }
  // General call: comma-separated expression args.
  i = open + 1
  let args = []
  i = skip_ws(s, i)
  if (s[i] !== ')') {
    while (true) {
      let { node, end: e } = parse_expr_at(s, i)
      args.push(node)
      i = skip_ws(s, e)
      if (s[i] === ',') { i = skip_ws(s, i + 1); continue }
      break
    }
  }
  if (s[i] !== ')') throw new Error(`expected ')' at pos ${i}`)
  return { node: { tag: 'func', name, args }, end: i + 1 }
}

function find_matching_paren(s, open) {
  let depth = 1, i = open + 1
  while (i < s.length && depth > 0) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    if (depth === 0) return i
    i++
  }
  throw new Error(`unmatched '(' at pos ${open}`)
}

export function parse_expr(text) {
  if (!text || !text.length) throw new Error('empty expression')
  let { node, end } = parse_expr_at(text, 0)
  let i = skip_ws(text, end)
  if (i < text.length) throw new Error(`trailing garbage at pos ${i}: ${text.slice(i)}`)
  return node
}

// Bare-name references in `text`, excluding language-built-in names
// (`null`, `unit`) and function arguments that are sort keys / hash
// algorithms / symbol names. Used by the compiler to compute
// dependencies of trie entries on other entities.
export function refs_in(text) {
  let names = new Set()
  walk_refs(parse_expr(text), names)
  return names
}

function walk_refs(node, names) {
  switch (node.tag) {
    case 'name':
      if (node.name !== 'null' && node.name !== 'unit')
        names.add(node.name)
      break
    case 'literal':
      break
    case 'concat':
      for (let p of node.parts) walk_refs(p, names)
      break
    case 'func': {
      // symbol(<name>) — arg is a literal symbol-table name, not a ref
      if (node.name === 'symbol') break
      // sort(<key>, …) / hash(<alg>, …) — first arg is a literal token
      let start = (node.name === 'sort' || node.name === 'hash') ? 1 : 0
      for (let i = start; i < node.args.length; i++) walk_refs(node.args[i], names)
      break
    }
  }
}

// ---- evaluator ------------------------------------------------------------

export async function evaluate(text, resolve_name) {
  return evaluate_node(parse_expr(text), resolve_name)
}

export async function evaluate_node(node, resolve_name) {
  switch (node.tag) {
    case 'name':    return eval_name(node.name, resolve_name)
    case 'literal': return eval_literal(node)
    case 'concat': {
      let parts = []
      for (let p of node.parts) parts.push(await evaluate_node(p, resolve_name))
      return concat_bytes(parts)
    }
    case 'func':    return eval_func(node, resolve_name)
    default: throw new Error(`unknown AST node: ${node.tag}`)
  }
}

function eval_name(name, resolve_name) {
  if (name === 'null') return new Uint8Array([0x00])
  if (name === 'unit') return new Uint8Array([0xff])
  if (!resolve_name) throw new Error(`unresolved name: ${name}`)
  let r = resolve_name(name)
  if (r == null) throw new Error(`unresolved name: ${name}`)
  return r instanceof Uint8Array ? r : hex_to_bytes(r)
}

function eval_literal(node) {
  if (node.kind === 'hex') {
    let cleaned = node.raw.replace(/\s+/g, '')
    if (cleaned === '') return new Uint8Array(0)
    if (cleaned.length % 2 !== 0) throw new Error('odd-length hex')
    return hex_to_bytes(cleaned)
  }
  if (node.kind === 'base64') {
    let cleaned = node.raw.replace(/\s+/g, '')
    let bin = atob(cleaned)
    let out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  throw new Error(`unknown literal kind: ${node.kind}`)
}

async function eval_func(node, resolve_name) {
  switch (node.name) {
    case 'symbol': {
      if (node.args.length !== 1) throw new Error('symbol() takes 1 arg')
      let arg = node.args[0]
      if (arg.tag !== 'name') throw new Error('symbol() arg must be a name')
      let hex = SYMBOLS[arg.name]
      if (!hex) throw new Error(`unknown symbol: ${arg.name}`)
      return hex_to_bytes(hex)
    }
    case 'sort': {
      if (node.args.length < 1) throw new Error('sort() requires at least a key')
      let key_arg = node.args[0]
      if (key_arg.tag !== 'name')
        throw new Error('sort() first arg must be a sort-key name')
      let key = key_arg.name
      if (!['lex', 'revlex', 'num', 'revnum'].includes(key))
        throw new Error(`unknown sort key: ${key}`)
      let parts = []
      for (let i = 1; i < node.args.length; i++)
        parts.push(await evaluate_node(node.args[i], resolve_name))
      parts.sort((a, b) => sort_cmp(key, a, b))
      return concat_bytes(parts)
    }
    case 'hash': {
      if (node.args.length !== 2) throw new Error('hash() takes 2 args')
      let alg = parse_hash_alg(node.args[0])
      let data = await evaluate_node(node.args[1], resolve_name)
      if (alg !== 0x41) throw new Error(`unsupported hash alg: 0x${alg.toString(16)}`)
      let digest = await sha256(data)
      let out = new Uint8Array(1 + digest.length)
      out[0] = alg
      out.set(digest, 1)
      return out
    }
    case 'sign':
    case 'shield':
      throw new Error(`${node.name}() not implemented yet`)
    default:
      throw new Error(`unknown function: ${node.name}`)
  }
}

// Algorithm specifier in hash(): either a bare name ('sha256', mapped to
// 0x41) or a hex byte ('0x41'). The grammar treats `0x41` as a name token
// because the read_name predicate accepts digits after the first char —
// `0x41` matches because `0` is treated as a name char by `is_name_part`
// once we've started a name. But `0` isn't `is_name_start`, so callers
// like `hash(0x41, ...)` need special handling.
//
// To keep the grammar simple, we accept the arg as either:
//   * a `name` node whose name is a known alg name or starts with 0x, or
//   * a `literal` node — not currently emitted for this; only `name`.
//
// In practice the parser sees `0x41` as part of an expression. It currently
// fails because `0` isn't a name-start. Workaround: allow a digit-start
// `name` specifically inside hash()'s first arg. Implemented by treating
// the first arg of hash() as a raw token captured during parsing — but
// that would require parser awareness of hash. Instead, do an inexpensive
// fall-through: read the alg arg as text and parse it here.
function parse_hash_alg(arg) {
  if (arg.tag === 'name') {
    let n = arg.name.toLowerCase()
    if (n === 'sha256') return 0x41
    let m = /^0x([0-9a-f]+)$/.exec(n)
    if (m) return parseInt(m[1], 16)
    throw new Error(`unknown hash alg name: ${arg.name}`)
  }
  throw new Error(`hash() alg must be a name`)
}

// ---- helpers --------------------------------------------------------------

function concat_bytes(parts) {
  let n = 0
  for (let p of parts) n += p.length
  let out = new Uint8Array(n)
  let off = 0
  for (let p of parts) { out.set(p, off); off += p.length }
  return out
}

function sort_cmp(key, a, b) {
  if (key === 'lex' || key === 'revlex') {
    let n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        let d = a[i] - b[i]
        return key === 'revlex' ? -d : d
      }
    }
    let d = a.length - b.length
    return key === 'revlex' ? -d : d
  }
  // num / revnum: pad shorter on the left with zeros to equal length, then
  // compare big-endian numerically. Equivalent to BigInt-comparing both
  // values but avoids allocations for short inputs.
  let n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    let ai = i < n - a.length ? 0 : a[i - (n - a.length)]
    let bi = i < n - b.length ? 0 : b[i - (n - b.length)]
    if (ai !== bi) {
      let d = ai - bi
      return key === 'revnum' ? -d : d
    }
  }
  return 0
}
