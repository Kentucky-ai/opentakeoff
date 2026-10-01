// The one consent path for on-device reads (#471). Every feature that reads
// text on-device (the canvas's Read, the gallery's Read, the copy tool's box
// read, Import from schedule's raster read) runs its work through
// session.run, which starts the engine the way the person agreed to:
//   • a notice is up (or its download running): join it;
//   • else ask the client without consent (ensureReady). It answers ok when
//     the engine is running or its files are cached, joins a start already
//     under way, answers disabled / uninstalled / error as they are, and
//     answers consent-required, starting nothing, when files are missing.
//     The probe isn't asked first: it sees only Cache Storage, so with none
//     (or after an eviction) it says "not cached" while the engine runs;
//   • only on consent-required: probe for the bytes missing, and the host
//     shows the download notice (requestConsent). Only its Download starts
//     a download (ensureReady with consent: true).
//
// run() never rejects. Any task failure once the caller has aborted is
// `aborted`; any other task error, an AbortError the caller didn't cause
// included (a page closed mid-read), is `failed` with the error, apart from
// a failed start (`error`).
//
// One notice at a time. Callers that need consent while a notice is up (or
// its download is running) wait on it: Download serves them all; a caller's
// abort resolves only that caller, whose task never runs; when the last
// waiter leaves, the notice's signal aborts (the host closes it) and so does
// the download. The notice's Cancel after Download (notice.cancel) declines
// every waiter and stops the download.
//
// Pure: the client is injected (the app's shared getOcrClient() by default,
// resolved on first use), so importing this touches no DOM and starts no
// worker.
import { getOcrClient, type OcrProbe, type OcrProgress, type OcrReady } from "./client";

/** What the host's notice hands the session. */
export interface ConsentNotice {
  /** Aborts when the notice must close: every waiter left, or the download
   * finished, failed or was cancelled. The host closes the notice then, and
   * doesn't need to answer requestConsent. */
  signal: AbortSignal;
  /** Register the notice's progress sink (OcrDownloadNotice's `progress`);
   * it hears the download's progress after Download. */
  onProgress(sink: (p: OcrProgress) => void): void;
  /** The notice's Cancel after Download: stops the download and declines
   * every waiter. Before Download, resolve requestConsent "cancel" instead. */
  cancel(): void;
}

/** Show the download notice for `downloadBytes`; resolve with the person's
 * answer. Only a press of Download may resolve "download". */
export type RequestConsent = (downloadBytes: number, notice: ConsentNotice) => Promise<"download" | "cancel">;

/** The client surface the session uses. */
export interface SessionClient {
  probe(): Promise<OcrProbe>;
  ensureReady(opts?: { consent?: boolean; signal?: AbortSignal; onProgress?: (p: OcrProgress) => void }): Promise<OcrReady>;
}

export type OcrRunResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "disabled" | "uninstalled" | "declined" | "aborted" }
  | { ok: false; reason: "error"; message: string }
  /** the task itself threw (not an abort) */
  | { ok: false; reason: "failed"; error: unknown };

export interface OcrSession {
  /** Start the engine as the person agreed, then run `task` with the
   * caller's signal. Never rejects; see OcrRunResult. */
  run<T>(task: (signal?: AbortSignal) => Promise<T>, opts?: { signal?: AbortSignal }): Promise<OcrRunResult<T>>;
  /** The probe alone, to decide whether to show Read at all: no notice, no
   * download, no worker. `disabled` / `uninstalled` hide OCR. One request
   * per session: concurrent callers share it and the answer is kept, except
   * an `error`, which is asked again on the next call. The kept answer's
   * `cached` / `downloadBytes` go stale after a download; run() doesn't use
   * them. */
  availability(): Promise<OcrProbe>;
}

type Failure = Exclude<OcrRunResult<never>, { ok: true } | { reason: "failed" }>;
type Outcome = { ok: true } | Failure;

const ABORTED: Failure = { ok: false, reason: "aborted" };
const DECLINED: Failure = { ok: false, reason: "declined" };

/** A start's answer as a run result. consent-required after a consented
 * start can only mean the download was given up: declined. */
function fromReady(r: OcrReady): Outcome {
  if (r.ok) return r;
  if (r.reason === "error") return { ok: false, reason: "error", message: r.message };
  if (r.reason === "consent-required") return DECLINED;
  return { ok: false, reason: r.reason };
}

function fromProbe(p: Exclude<OcrProbe, { state: "available" }>): Failure {
  return p.state === "error" ? { ok: false, reason: "error", message: p.message } : { ok: false, reason: p.state };
}

/** The notice up now: who waits on it, and its download's progress sinks. */
interface Pending { waiters: Set<(o: Outcome) => void>; ac: AbortController; sinks: Set<(p: OcrProgress) => void> }

export function createOcrSession(deps: { client?: SessionClient; requestConsent: RequestConsent }): OcrSession {
  const { requestConsent } = deps;
  let client: SessionClient | null = deps.client ?? null;
  const getClient = () => (client ??= getOcrClient());
  let pending: Pending | null = null;

  /** Close `p` (the host hides the notice, a download stops) and answer
   * whoever still waits. */
  function settle(p: Pending, o: Outcome) {
    if (pending === p) pending = null;
    p.ac.abort();
    const ws = [...p.waiters];
    p.waiters.clear();
    for (const w of ws) w(o);
  }

  function openNotice(downloadBytes: number): Pending {
    const p: Pending = { waiters: new Set(), ac: new AbortController(), sinks: new Set() };
    const notice: ConsentNotice = {
      signal: p.ac.signal,
      onProgress: (sink) => { p.sinks.add(sink); },
      cancel: () => settle(p, DECLINED),
    };
    void (async () => {
      let answer: "download" | "cancel";
      try {
        // Asked a microtask later, so the caller that opened the notice is
        // waiting on it even if the host throws at once.
        answer = await Promise.resolve().then(() => requestConsent(downloadBytes, notice));
      } catch (err) {
        settle(p, { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (p.ac.signal.aborted) return; // closed: everyone left, or cancelled
      if (answer !== "download") return settle(p, DECLINED);
      const r = await getClient().ensureReady({
        consent: true,
        signal: p.ac.signal,
        onProgress: (pr) => { for (const s of p.sinks) s(pr); },
      });
      settle(p, fromReady(r));
    })();
    return p;
  }

  /** Wait on notice `p` until Download's start settles, Cancel, or this
   * caller's abort. */
  function join(p: Pending, signal?: AbortSignal): Promise<Outcome> {
    if (signal?.aborted) return Promise.resolve(ABORTED);
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!p.waiters.delete(waiter)) return;
        resolve(ABORTED);
        // The last one out closes it now, not when the host answers: a host
        // told to close may never answer.
        if (p.waiters.size === 0) settle(p, ABORTED);
      };
      const waiter = (o: Outcome) => { signal?.removeEventListener("abort", onAbort); resolve(o); };
      p.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function ready(signal?: AbortSignal): Promise<Outcome> {
    if (pending) return join(pending, signal);
    const c = getClient();
    const r = await c.ensureReady({ signal });
    if (r.ok || r.reason !== "consent-required") return fromReady(r);
    // Files missing: ask the person, for what is missing now. A notice
    // opened meanwhile is joined below.
    const probe = await c.probe();
    // Needed: aborted during the probe, this caller would open a notice
    // that nobody waits on, so nothing would ever close it.
    if (signal?.aborted) return ABORTED;
    if (probe.state !== "available") return fromProbe(probe);
    return join(pending ?? (pending = openNotice(probe.downloadBytes)), signal);
  }

  let avail: Promise<OcrProbe> | null = null;

  return {
    async run(task, opts = {}) {
      const { signal } = opts;
      if (signal?.aborted) return ABORTED;
      let r: Outcome;
      try {
        r = await ready(signal);
      } catch (err) {
        r = { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
      }
      if (!r.ok) return r;
      // Needed: the start can answer ok just before the caller aborts.
      if (signal?.aborted) return ABORTED;
      try {
        return { ok: true, value: await task(signal) };
      } catch (error) {
        // Only the caller's own abort is `aborted`. An AbortError it didn't
        // ask for (readRegionText's "The page was closed during the read.")
        // is `failed`, so the host can say what happened.
        if (signal?.aborted) return ABORTED;
        return { ok: false, reason: "failed", error };
      }
    },
    availability() {
      if (!avail) {
        const p: Promise<OcrProbe> = getClient().probe().then(
          (a) => { if (a.state === "error" && avail === p) avail = null; return a; },
          (err) => { if (avail === p) avail = null; return { state: "error", message: err instanceof Error ? err.message : String(err) }; },
        );
        avail = p;
      }
      return avail;
    },
  };
}
