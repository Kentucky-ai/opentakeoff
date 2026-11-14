# door-reader

Every door swing drawn on a plan page, read from the page's own vector linework. Rust, no dependencies, built to
WebAssembly and committed as `web/src/lib/doorReader.wasm` (plus `doorReaderWasm.ts`, the same bytes as base64), so the
app and the MCP server run it with no Rust toolchain.

- Input: the page's painted paths as flat `f64` arrays (`web/src/lib/doorVectors.ts` extracts them with pdf.js). Layout in `src/wasm.rs`.
- Output: one record per door (box, jamb-to-jamb line, single or pair, stall, dashed, each leaf's hinge, radius and tip), the scale used, and how it was found.
- Pairs: two leaves hinged one door apart, drawn alike, their swings' ends meeting in the middle. Leaves that rule leaves
  single get a second look: swings drawn short of closed (leaves square to the opening, each swing on its mate's side and
  as far short of the closing point as its own sweep leaves it), and a pair with one leaf line along the opening (both
  swings end on the closing point, drawn alike). Neither applies where a wall runs on from a swing's closed end.
- Jamb line: hinge to hinge for a pair; for one leaf, hinge to the swing's closed end, or hinge to the leaf's tip where the wall's linework runs on past that line instead (a door drawn shut, or a leaf and closed end told apart wrongly). Where both faces of a wall start at the closed end and run on, with the closed line on one of them or between them, the wall is cut off there by the opening and the closed line stands, whatever lies along the leaf (a door standing open against a side wall).
- Method: arcs from Bezier curves, polylines and loose or dashed strokes; a door keeps its arc when it has a leaf (drawn,
  dashed, or a quarter arc spanning a wall opening) and a wall at the hinge. Circles, revision-cloud scallops, logos and
  casework doors are left out; toilet-partition stalls are marked; two leaves meeting in one opening are a pair. With no
  sheet scale, the commonest leafed radius is read as a 3-ft door.

```sh
npm run build:door-reader --prefix web          # rebuild the module from source (rustup stable + wasm32-unknown-unknown)
npm run check:door-reader:source --prefix web   # fail unless the committed module is what the source builds to
npm run check:door-reader --prefix web          # no Rust needed: the .ts embeds exactly the committed .wasm
npm run bench:doors --prefix web -- <labels dir> <out dir>   # score against a door-layer answer key (see bench/doors/run.mts)
```

`examples/` holds native tools for working on the rules: `profile` (stage timings), `why` and `audit` (the keep rule's
verdict on the arcs near given boxes), `arcat` (every arc read in a region), `whypair` (what the pair rule measures on the swings near a point). They read a sheet dumped by
`web/bench/doors/dump.mts`.
