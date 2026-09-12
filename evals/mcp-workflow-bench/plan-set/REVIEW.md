# Review state of the references

| Plan | Prepared by | Method | Agent zoom-inspected | Human reviewed | Reviewer | Date |
|---|---|---|---|---|---|---|
| all three, **v2** (2026-09-12) | same authoring agents, directed by the same agent | re-authored from the linework for the defects listed in `BLIND-RUNS-2026-09-12.md`; overlays in each plan's `crops-v2/` | yes: every corrected item at zoom 4–10 by the authoring agent and the disputed spots by the directing agent | **no** | — | — |
| `stcloud/` | Claude Sonnet subagent, directed by Claude Fable | PyMuPDF vector segments in the tool frame; wall faces = the 1.68 px strokes; vertices snapped to cited segments; SF by shoelace; scale checked against the printed 16 SF in 134A (+2.2 %); overlays at zoom 2 and 4–8 | yes: every room at zoom 4 by the authoring agent, 137 twice (the corridor door notch and the east-wall reveal were corrected on the second pass); 134, 134A, 137 and the six-ring overlay re-inspected by the directing agent | **no** | — | — |
| `roseburg/` | Claude Sonnet subagent, directed by Claude Fable | PyMuPDF vector segments (`get_drawings`) in the tool frame; vertices snapped to cited segments; SF by shoelace; overlays at zoom 2 and 4–6 | yes: every corner and door notch of D105B, D105A, D104, D105 at zoom 4–6 by the authoring agent; D105A and the four-room overlay re-inspected by the directing agent | **no** | — | — |
| `porterville/` | Claude Sonnet subagent, directed by Claude Fable | same method; scale verified against six printed dimension strings (all within 0.3 px); overlays at zoom 2 and 4 | yes: every room at zoom 4 by the authoring agent, twice (the second pass after three openings were corrected to shared centerline notches); the six-room overlay and OPT. BEDROOM re-inspected by the directing agent | **no** | — | — |

A reference becomes reviewed only when a person has looked at the overlay crops in that
plan's `crops/` folder against the sheet and written their name and date here. Until
then every ring is a proposal, and an agent run that matches it proves agreement with
the proposal, not accuracy.

What a reviewer checks per room: the ring is on the innermost wall face on every side;
every door has its notch and no window does; steps and pilasters are followed; the
finish tag matches the schedule; for split rooms the two rings share the transition line.
