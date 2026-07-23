// Vite asset-import shims for the strict-checked .ts modules (the canvas .jsx
// side never needed them). `?url` returns the served/emitted asset URL — the
// STT adapter uses it to pin the ORT wasm runtime same-origin (RFC #59).
declare module "*?url" {
  const url: string;
  export default url;
}
