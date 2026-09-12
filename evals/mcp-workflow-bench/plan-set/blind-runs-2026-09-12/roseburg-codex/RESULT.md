# Roseburg A-03a — Codex blind run 1 (OpenAI Codex CLI 0.154.0, model gpt-6-astra, effort high), 2026-09-12

Same prompt, task text, relay build and blind rules as the first agent's run in `../roseburg/`. Frozen export sha256 in FREEZE.sha256. 33 tool calls (11 view_sheet, 5 get_sheet_vectors, 4 measure_polygon, 4 edit_shape for labels, 0 geometry edits).

## Score vs reference v2: 3 of 4 rooms pass (identical to the first agent's run)
| Room | Codex | first agent |
|---|---|---|
| D105B STORAGE | 39.83 SF, IoU 0.9999, 0.1 px, PASS | 39.83 SF, IoU 1.0, 0.0 px, PASS |
| D105A OFFICE | 111.71 SF, IoU 0.9999, 0.0 px, PASS | 111.70 SF, IoU 1.0, 0.0 px, PASS |
| D104 OFFICE | 87.23 SF, IoU 0.940, 108 px, FAIL (alcove included) | 87.23 SF, IoU 0.940, 108 px, FAIL (alcove included) |
| D105 OFFICE | 90.63 SF, IoU 0.9997, 0.1 px, PASS | 90.62 SF, IoU 0.9998, 0.1 px, PASS |

Both agents read the D104 sink alcove the same way (Q13: include, the heavy stroke is a screen line, hatch continuous) and both put D105A's east stub on the wall face at 4303.8, which is what v2 was corrected to. Neither made an error the other did not. Codex used 4 more calls (five `get_sheet_vectors` region pulls to Claude's one) and also verified its own export with `import_takeoff`.
