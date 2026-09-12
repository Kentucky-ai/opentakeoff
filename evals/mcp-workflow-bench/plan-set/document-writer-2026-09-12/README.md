# One writer for the takeoff document — browser proof (2026-09-12)

Evidence for the change that made `web/src/lib/takeoffDocument.js` the single writer of the
`opentakeoff.takeoff_canvas.v1` envelope for the canvas and the MCP server (0.9.86). The
question this answers: does a document the server writes with the new envelope still land,
review, export, archive and reopen in the app exactly as before?

Method, all headless and scripted (no human approval was given anywhere in this run):

1. `make-agent-export.mjs` builds `agent-export.takeoff.json` with the server: the St. Cloud
   AF101 v2 reference rings (`../stcloud/reference.json`), one condition per finish, detected
   scale. The envelope is the app's: `schema` first, no `units` key (imperial), no empty
   `sheet_levels`, `rfis: []`, and every minted condition carries `created_at`.
2. Phase A (`phaseA-log.json`, `phaseA-*.jpg`): the P3-D walkthrough driver
   (`../human-review-2026-09-12/cdp-review-walkthrough.mjs`) opens the plan in a throwaway
   headless Chrome, adopts the scale, imports that file, selects a ring, nudges one corner,
   clicks the Accept pill, exports the takeoff JSON (`browser-export-after-review.takeoff.json`),
   exports the project archive, opens the report and downloads the marked set.
3. Phase B (`phaseB-log.json`, `phaseB-*.jpg`): a second Chrome with a fresh profile opens the
   archive and exports the takeoff again (`browser-export-after-reopen.takeoff.json`).
4. `reopen-compare.json`: the two browser exports have the same key order as the server's
   document, identical shapes (geometry, computed SF, review state), conditions and sheets;
   0 approvals in both; `units` absent in both; `created_at` on every condition.

What it shows: the six agent rings landed dashed with one Accept pill (phase A shot 04); the
corrected ring re-priced (06); the batch inked (07); the report priced the accepted rings (10);
the archive reopened on a clean profile with ink, not pencil (phase B shot 03).

What it does not show: human review. The Accept click was a script in a throwaway browser.
