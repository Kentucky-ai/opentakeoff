# Union URL migration

All seven links across the English README, Chinese README and agent guide now point directly to `https://union.kentucky-ai.com`. Nine occurrences of the old hostname (including two visible URL labels) became zero. OpenTakeoff Academy is identified as the Union's evaluation and certification arm. No application or engine behavior changed.

Rendered GitHub review: [README screenshot](readme.png).

Measured before/after counts: [link-audit.json](link-audit.json).

Validation: Node 24, fresh `npm ci`, staged verified OCR and voice models, then `npm run check`: typecheck, lint, shared ORT check, **3,147 tests passed; zero failed/skipped**, benchmark, production build, and packaged OCR check all passed. The benchmark left the tracked results unchanged.

Reproduce link counts:

```sh
rg -n 'aec\.kentucky-ai\.com|union\.kentucky-ai\.com' README.md README.zh-Hans.md docs/AGENT_GUIDE.md
curl -I https://union.kentucky-ai.com/
cd web
npm ci
node scripts/stage-ocr-model.mjs
node scripts/fetch-voice-model.mjs
npm run check
```

The Union homepage returned HTTPS 200 during review. Certification checkout and funded bounty work remain unavailable; this documentation migration does not advertise a payment launch.
