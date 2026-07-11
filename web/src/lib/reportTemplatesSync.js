// Optional Drive sync for saved report templates (issue #115).
//
// Saved templates live per-browser in localStorage (reportTemplates.js). This
// module lets a signed-in user carry them across their own devices by parking a
// copy in Drive — PER USER, namespaced by email, under a hidden ".opentakeoff"
// folder at the team's Projects root. Per-user (not one shared root file) so a
// teammate's push/delete never clobbers your saved layouts; a deliberate shared
// "team library" would be a separate feature.
//
// The email namespace is an ORGANIZATION convention, not an access boundary: the
// folder inherits the Projects Shared-Drive ACL, so a teammate with Drive access
// could read another's templates file directly — exactly as project data itself
// is team-shared. Report layouts (column visibility + grouping) carry no
// sensitive data, and the UI only ever reads/writes the signed-in user's own
// file, so this matches the app's existing trust model rather than widening it.
//
// The Drive client is INJECTED (createDrive from google/drive.js) so this whole
// surface is node-testable with a fake drive — no network, no login. Semantics
// are MVP: Push = write the local set to your file (last-write-wins on it);
// Load = merge the file into local, local wins (see mergeTemplates). No live
// sync, no remote-delete propagation.
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SYNC_FOLDER = ".opentakeoff";

// Push/Load are offered only when BOTH hold: a signed-in user with an email
// (the namespace key) and a configured Projects root to store under. Pure so the
// popover's gate is a tested predicate, not inline JSX truthiness.
export function canSyncTemplates(user, driveRootFolderId) {
  return !!(user && typeof user.email === "string" && user.email.trim() && driveRootFolderId);
}

// The per-user filename. Lower-cased so the same account resolves to one file
// regardless of how Drive/casing echoes the address back across devices.
export function templatesFileName(email) {
  return `report-templates-${String(email).trim().toLowerCase()}.json`;
}

// Resolve the hidden sync folder unambiguously by LISTING folder-typed children
// and matching the name — not findChild, which matches on name only and returns
// the first hit. A stray non-folder named ".opentakeoff" could otherwise sort
// ahead of the real folder and shadow it: push would keep minting duplicate
// folders and load would return [] while the templates sit right beside it.
async function findSyncFolder(drive, rootFolderId) {
  const folders = await drive.listChildren(rootFolderId, { mimeType: FOLDER_MIME });
  return folders.find((f) => f.name === SYNC_FOLDER) || null;
}

// Find the hidden sync folder at the root, or create it.
async function ensureSyncFolder(drive, rootFolderId) {
  return (await findSyncFolder(drive, rootFolderId)) || drive.createFolder(rootFolderId, SYNC_FOLDER);
}

// Write the local template set to the user's Drive file (create, or update in
// place when it already exists). Returns { id, count }.
export async function pushTemplatesToDrive(drive, rootFolderId, email, templates) {
  const folder = await ensureSyncFolder(drive, rootFolderId);
  const name = templatesFileName(email);
  const existing = await drive.findChild(folder.id, name);
  const res = await drive.putJson({ folderId: folder.id, name, data: templates, existingId: existing ? existing.id : null });
  return { id: res.id, count: Array.isArray(templates) ? templates.length : 0 };
}

// Read the user's Drive file. Returns the raw parsed array (the caller merges it
// into local via mergeTemplates, which sanitizes). Missing folder or file → []
// (nothing synced yet is a normal first-Load state, not an error).
export async function loadTemplatesFromDrive(drive, rootFolderId, email) {
  const folder = await findSyncFolder(drive, rootFolderId);
  if (!folder) return [];
  const file = await drive.findChild(folder.id, templatesFileName(email));
  if (!file) return [];
  const data = await drive.getJson(file.id);
  return Array.isArray(data) ? data : [];
}
