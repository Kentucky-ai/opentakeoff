import { mergeConfig } from "vite";
import base from "../../vite.config.js";
export default mergeConfig(base, { build: { outDir: "dist-ocr-codes", rollupOptions: { input: "bench/ocr-codes/index.html" } } });
