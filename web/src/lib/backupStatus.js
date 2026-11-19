// Backup status: whether this browser promised to keep OpenTakeoff's storage,
// when the person last downloaded a full backup, and whether to remind them.
//
// One localStorage key (opentakeoff_backup_state), read and written inside
// try/catch so blocked storage only means "no record". It belongs to this
// browser, so Export everything leaves it out (browserExport.storageExclusion).
//
//   { persist: { granted, supported, checked }, last_backup, dismissed }

export const BACKUP_STATE_KEY = "opentakeoff_backup_state";
export const REMIND_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

function storageOf(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function readBackupState(storage) {
  try {
    const raw = storageOf(storage)?.getItem(BACKUP_STATE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function writeBackupState(patch, storage) {
  const next = { ...readBackupState(storage), ...patch };
  try { storageOf(storage)?.setItem(BACKUP_STATE_KEY, JSON.stringify(next)); } catch { /* blocked storage: nothing kept */ }
  return next;
}

/**
 * Ask the browser once to keep this site's storage (navigator.storage.persist)
 * and record the answer. Never throws, never blocks: the app renders while
 * this runs. An answer already granted is only re-read (persisted()).
 * @param {{ nav?: any, storage?: any, now?: () => Date }} [opts]
 */
export async function requestPersistentStorage({ nav = globalThis.navigator, storage, now = () => new Date() } = {}) {
  const sm = nav?.storage;
  if (!sm || typeof sm.persist !== "function") {
    return writeBackupState({ persist: { granted: false, supported: false, checked: now().toISOString() } }, storage).persist;
  }
  let granted = false;
  try {
    granted = typeof sm.persisted === "function" ? await sm.persisted() : false;
    if (!granted) granted = await sm.persist();
  } catch { granted = false; }
  return writeBackupState({ persist: { granted: granted === true, supported: true, checked: now().toISOString() } }, storage).persist;
}

/** Record a finished full backup (clears any dismissal). */
export function markBackupDone(storage, now = new Date()) {
  return writeBackupState({ last_backup: now.toISOString(), dismissed: null }, storage);
}

/** "Not now": quiet for the next 14 days. */
export function dismissBackupReminder(storage, now = new Date()) {
  return writeBackupState({ dismissed: now.toISOString() }, storage);
}

const age = (iso, now) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? now.getTime() - t : Infinity;
};

/**
 * Whether to show the backup reminder, and which reason to give.
 * Shown only when there is something to lose (`hasData`), when the browser
 * hasn't promised to keep it OR no backup was made in 14 days, and not
 * within 14 days of a dismissal.
 * @returns {null | "not-persisted" | "stale"}
 */
export function backupReminder(state, { hasData, now = new Date() }) {
  if (!hasData) return null;
  if (age(state?.dismissed, now) < REMIND_AFTER_MS) return null;
  const persisted = state?.persist?.granted === true;
  const recent = age(state?.last_backup, now) < REMIND_AFTER_MS;
  if (!persisted && !recent) return "not-persisted";
  if (!recent) return "stale";
  return null;
}
