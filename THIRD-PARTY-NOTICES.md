# Third-party notices

OpenTakeoff is Apache-2.0 licensed. It builds on the following open-source projects,
which retain their own licenses:

| Project | License | Use |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache-2.0 | PDF parsing & rendering (incl. the bundled `pdf.worker`) |
| [React](https://github.com/facebook/react) / `react-dom` | MIT | UI runtime |
| [React Router](https://github.com/remix-run/react-router) | MIT | Routing |
| [Vite](https://github.com/vitejs/vite) | MIT | Build tool / dev server |
| [fflate](https://github.com/101arrowz/fflate) | MIT | Unzipping dropped `.zip` plan sets (lazy-loaded) |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | MIT | Wrapping dropped images into PDFs (lazy-loaded) |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Type-checking the geometry libs |
| [tsx](https://github.com/privatenumber/tsx) | MIT | Running TS tests under Node |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`) | MIT | The `mcp/` server's protocol layer (stdio + in-memory test transport) |
| [Zod](https://github.com/colinhacks/zod) | MIT | Tool-input validation in `mcp/` |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`) | MIT | Runs the on-device OCR and voice models; ships the runtime wasm (`ort-wasm-simd-threaded.asyncify.wasm`) |
| [ppu-paddle-ocr](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr) | MIT | On-device OCR engine in the OCR worker (`web/src/ocr.worker.ts`) |
| [ppu-ocv](https://github.com/PT-Perkasa-Pilar-Utama/ppu-ocv) | MIT | Canvas image processing for ppu-paddle-ocr, bundled with the OCR worker's code |
| [PP-OCRv5 mobile detection model](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) (PaddlePaddle) | Apache-2.0 (model card) | On-device OCR text detection; staged by `web/scripts/stage-ocr-model.mjs`, not committed |
| [PP-OCRv5 mobile English recognition model](https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx) (PaddlePaddle) | Apache-2.0 (model card) | On-device OCR text recognition; staged by `web/scripts/stage-ocr-model.mjs`, not committed |

The optional AI sandbox (`/server`) additionally uses
[FastAPI](https://github.com/fastapi/fastapi) (MIT), [Starlette](https://github.com/encode/starlette) (BSD-3-Clause),
[Uvicorn](https://github.com/encode/uvicorn) (BSD-3-Clause), and [Pydantic](https://github.com/pydantic/pydantic) (MIT).

`web/scripts/ocr/en_PP-OCRv5_mobile_rec.inference.yml` is the recognition model's
`inference.yml` from its Hugging Face repository at the commit pinned in
`web/scripts/stage-ocr-model.mjs`, kept for provenance. `web/scripts/ocr/ppocrv5_en_dict.txt`
is the character list extracted from that file's `character_dict`.

`pdf.js` is distributed under the Apache License 2.0; a copy of that license is
available at <https://github.com/mozilla/pdf.js/blob/master/LICENSE>.
