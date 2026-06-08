// Spec-defined symbol atoms. Each value is the 33-byte hash (0x22 algo byte
// + 32-byte digest) as hex. The digest body is fixed by the rigging / abject
// specs — it isn't sha256(name); each name is bound to a specific value.
// Mirrors `abject.actionable.symbols/sym-context` etc. on the Clojure side
// and the SYM_*_HEX constants in rustoda/abjectcheck/src/symbols.rs.

export const SYMBOLS = {
  poptop:             '22c70173874680c58e5c1d32854bd10486aac6f1aa821b56e3d512fd72e45ac72e',
  context:            '2208318633b506017519e9b90b0bdc8451772415ba29144ab7778cb09cc2d2fa6a',
  // Actionable class identifiers — referenced from abject focus / cargo
  // tries. Useful once trie / abject support lands; harmless to ship now.
  'delegate-initiate': '22251dbe656f28f8fd46de35a13c1d74921cb73c1c198800b77eb2417f09435a82',
  'delegate-confirm':  '2246de612f227162a3d60819c45d88ba2d88d74aa86d64f865bf371be5ec8c52f0',
  'delegate-complete': '229b2a6d33408bc08d1af4ec63f0fb8e627d6e3b4d3f208e90390c3d8df789de34',
  DI:      '22fcef42f4592bb500a6e03fdb0c80ef679e5dce3cbb3c1ab986108b86651ccb12',
  SR:      '224a77394f604847ace4358961d501d95c19ec9b9572ee877368a274411daf01fb',
  SDA:     '224a77394f604847ace4358961d501d95c19ec9b9572ee877368a274411daf01fc',
  DQ:      '220a6a20be9131b708b193e1373aa4df209719e1d3f451836fa62245e4aed234a7',
  R1:      '220f6bc568a5f958111ce3c9d022bb03cf236827303b22b0af9d53eacf886c59ce',
  M1:      '2285f216a38f53803b9c22de0f8fa335cae4c5c6a4faa28491d4ff2676867230c9',
  Boolean: '2209b7efb95a393d9ee01f6446f362e5cf56d5eee55b00e6118db367e28c6a945e',
  'UTF-8': '22afcfeed9b1c0a28ed7d197f23e7d33272bdb562aa8d9ccf151b8f9767ca09032',
  'IEEE-754': '22f2781cc0020c300c84c3b9bfbe38ceb8949f2c1ced61e29f25c90ff853eb83e4',
}
