// How a marked sheet's page gets onto the marked set: as a vector copy of the
// source page, or as a raster of it.
//
// The vector copy (pdf-lib copyPages / embedPage) needs the source page's
// content streams to be readable. An ENCRYPTED source — owner password set,
// user password empty, the common "no copying" export — is not: pdf-lib loads
// it with ignoreEncryption, copies the still-encrypted bytes without a word,
// and every viewer then shows a blank sheet; the stitched (embedPage) path
// throws at save instead. pdf.js renders the same file normally, so the
// canvas never hinted. Those sheets go the raster way — the dark-mode path
// without the inversion — and the sheet stamp says so.
//
// Pure: the decision and its disclosure live here so a node test can pin
// them (test/markedsetSource.test.ts), beside the pdf-lib behaviour that
// forces the fallback, on a real encrypted fixture.

/** "vector" | "raster" | "raster-inverted" */
export function sourcePageMode({ dark = false, encrypted = false } = {}) {
  if (dark) return "raster-inverted";      // the dark canvas exports a dark set: raster by design
  if (encrypted) return "raster";          // vector copy impossible — see above
  return "vector";
}

/** What the sheet stamp appends when the page is a raster for a reason the
 *  reader should know. Dark mode is the user's own setting; it needs no note. */
export function sourceStampNote(mode) {
  return mode === "raster" ? " · raster copy — the source PDF is encrypted, so its vector page cannot be embedded" : "";
}

/** The refusal when a forced raster has nowhere to render — the MCP server
 *  runs this module with no DOM (light mode only, by design), so an encrypted
 *  source there is named, not printed blank and not left as a stack trace. */
export function noCanvasForRasterMessage(label) {
  return `${label ? `${label}: ` : ""}the source PDF is encrypted, so its page cannot be copied as vector, and this environment has no canvas to render it as an image. Export the marked set from the app, or supply an unencrypted PDF.`;
}
