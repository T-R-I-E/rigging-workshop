# rustoda

A Rust CLI tool that verifies TODA file rigs. Given a `.toda` file and a poptop twist identifier, it checks whether the focus (the last twist in the file) is supported by the line containing the poptop.

## Build

```
cargo build --release
```

## Usage

```
rigcheck <file.toda> <poptop_hex>
```

### Output

- `pass` — the focus is fully supported by the poptop's line (corkline)
- `PARTIAL PASS` — the focus is supported up to a trusted intermediary line, but not yet verified all the way to the corkline
- On failure, a JSON status abject is printed to stderr describing why verification failed, and the process exits with code 1

### Example

```
$ rigcheck dq.toda 41cb12966be3bb1d0dffb060dca3579ed800e52e59d30e72fe79aefdfaefb89dd9
pass
```

## How it works

The tool parses the TODA atom serialization format, then traverses the rig structure:

1. Identifies the **leadline** (the focus's line) and the **corkline** (the poptop's line)
2. Walks up from the leadline through intermediate lines, verifying **half-hitches** at each level using the shielded retrieval function (µʳ from *Shielded Hitches Are Oblivious*)
3. Extends forward along the leadline as far as the rig supports
4. Checks that the focus falls within the supported range

If the full chain to the corkline isn't available, the tool falls back to **trusted intermediary** evaluation per *A funny thing happened on the way to the corkline* §3.

## References

- [Rigging Specifications](https://www.todaq.net/rigging_specifications.pdf) — TODA atom format, rig structure, status abjects
- *A funny thing happened on the way to the corkline* — extended splicing/lashing, trusted intermediaries
- *Shielded Hitches Are Oblivious* — shielded hoist mechanism providing falsifiability, front-running resistance, and censorship resistance
