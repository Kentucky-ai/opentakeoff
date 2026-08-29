# Room-detection harnesses

Scoring and PROOF-image tools for the room-detection program.

They read the owner's hand takeoffs from `~/Desktop/OT-Corpus/all-goldens.json`
and the plan PDFs from the same folder. **Those files are real client plans and
never enter the repo** — only these scripts do.

    node --import tsx bench/roomdet/show.mjs  <pdf> <sheet_id> <page> <pxPerFt> <x0,y0,x1,y1> <out.png>
    node --import tsx bench/roomdet/room.mjs  <pdf> <sheet_id> <page> <pxPerFt>
    node --import tsx bench/roomdet/frag.mjs  <pdf> <sheet_id> <page> <pxPerFt> <x0,y0,x1,y1> [mode]

- **show.mjs** — the PROOF renderer. His ring GREEN, yours BLUE within 5% / RED outside.
  This is how results are reported: he does not accept numbers he cannot see.
- **room.mjs** — planar arrangement + wall-bounded growth, scored per room.
- **multi.mjs** — any approach vs the flood, per sheet.
- **frag.mjs** — click stability: grid of clicks in one room, count DISTINCT answers.
  Matches the real complaint ("click two inches over, different number").
- **arrsheet.mjs / scoreDrawn.mjs** — earlier attempts, kept for their scoring shape.
