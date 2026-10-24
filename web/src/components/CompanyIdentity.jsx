// Company identity — the trade-name profiles (lib/identity.js) as one hook plus
// one field block, shared by Project info (ReportPanel) and Company setup so the
// two dialogs can never drift. Profiles are per-device and save on every change.
import React, { useEffect, useRef, useState } from "react";
import { normalizeLogoToPng, loadProfiles, saveProfiles, activeProfile, updateActiveProfile, addProfile, setActiveProfile, removeProfile } from "../lib/identity.js";

export function useCompanyProfiles(onSaved) {
  const [profs, setProfs] = useState(loadProfiles);
  const [logoErr, setLogoErr] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  // pick sequence: normalizeLogoToPng is async, so a slow first pick must not
  // clobber a faster second pick — resurrect a logo removed meanwhile — or land
  // after the dialog closes (a pick still normalizing would otherwise persist
  // from the dead fiber)
  const logoSeq = useRef(0);
  useEffect(() => () => { logoSeq.current++; }, []);   // unmount invalidates in-flight picks

  // one commit path: a producer runs against the CURRENT state (functional set,
  // so a slow logo normalize can't revert a name typed meanwhile), persists, and
  // bumps the masthead via onSaved. saveProfiles also mirrors the active profile
  // to the legacy company key (backward compat).
  const commit = (produce) => {
    setProfs((prev) => {
      const next = produce(prev);
      const ok = saveProfiles(next);
      setSaveFailed(!ok);
      if (ok && onSaved) onSaved();
      return next;
    });
  };
  // edit the active profile's fields — creates a first profile if none exists yet
  const editActive = (fields) => commit((prev) => (prev.profiles.length ? updateActiveProfile(prev, fields) : addProfile(prev, fields).state));
  const onLogoFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // re-picking the same file must still fire onChange
    if (!file) return;
    setLogoErr("");
    const seq = ++logoSeq.current;
    try {
      const logo = await normalizeLogoToPng(file);
      if (seq !== logoSeq.current) return;   // superseded by a later pick/remove/close
      editActive({ logo });
    } catch (err) {
      if (seq !== logoSeq.current) return;   // stale failure — don't flash its error
      setLogoErr(err.message || String(err));
    }
  };
  return {
    profs, active: activeProfile(profs) || {}, logoErr, saveFailed,
    editActive,
    switchProfile: (id) => commit((prev) => setActiveProfile(prev, id)),
    addTradeName: () => commit((prev) => addProfile(prev, {}).state),
    deleteActive: () => commit((prev) => removeProfile(prev, prev.activeId)),
    onLogoFile,
    // bump the seq so an in-flight pick can't resurrect the removed logo; "" clears
    removeLogo: () => { logoSeq.current++; editActive({ logo: "" }); },
  };
}

const row = { display: "block", margin: "8px 0" };
const err = { margin: "6px 0 0", fontSize: 11.5, color: "var(--c-danger)" };

/** @param {{ company: ReturnType<typeof useCompanyProfiles>, contact?: boolean }} props
 *  contact adds phone / email / license — the bid-proposal letterhead fields. */
export function CompanyIdentityFields({ company, contact = false }) {
  const { profs, active, logoErr, saveFailed, editActive, switchProfile, addTradeName, deleteActive, onLogoFile, removeLogo } = company;
  return (
    <>
      {/* trade-name picker: choose which identity prints on the report + marked-set */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}>
        <select name="trade-name" aria-label="Active trade name" value={profs.activeId || ""} onChange={(e) => switchProfile(e.target.value)}
          className="field-input" style={{ flex: 1, minWidth: 0 }} disabled={!profs.profiles.length}>
          {profs.profiles.length === 0 && <option value="">No trade name yet — add one</option>}
          {profs.profiles.map((p) => <option key={p.id} value={p.id}>{p.name || "Untitled trade name"}</option>)}
        </select>
        <button onClick={addTradeName} className="btn-ghost" title="Add another trade name (e.g. a second brand)"
          style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>+ Add</button>
        {profs.profiles.length > 1 && (
          <button onClick={deleteActive} title="Delete the selected trade name"
            style={{ padding: "5px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}>Delete</button>
        )}
      </div>
      <label style={row}>
        <span className="field-label">Name</span>
        <input name="company-name" autoComplete="organization" value={active.name || ""} onChange={(e) => editActive({ name: e.target.value })}
          placeholder="Your trade name" className="field-input" style={{ marginTop: 4 }} />
      </label>
      <label style={row}>
        <span className="field-label">Address</span>
        <textarea name="company-address" autoComplete="street-address" value={active.address || ""} onChange={(e) => editActive({ address: e.target.value })}
          rows={2} placeholder={"Street\nCity, ST"} className="field-input" style={{ marginTop: 4, resize: "vertical" }} />
      </label>
      {contact && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <label style={{ ...row, flex: "1 1 140px" }}>
            <span className="field-label">Phone</span>
            <input name="company-phone" type="tel" autoComplete="tel" value={active.phone || ""} onChange={(e) => editActive({ phone: e.target.value })}
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ ...row, flex: "1 1 180px" }}>
            <span className="field-label">Email</span>
            <input name="company-email" type="email" autoComplete="email" value={active.email || ""} onChange={(e) => editActive({ email: e.target.value })}
              className="field-input" style={{ marginTop: 4 }} />
          </label>
          <label style={{ ...row, flex: "1 1 140px" }}>
            <span className="field-label">License no.</span>
            <input name="company-license" autoComplete="off" value={active.license || ""} onChange={(e) => editActive({ license: e.target.value })}
              className="field-input" style={{ marginTop: 4 }} />
          </label>
        </div>
      )}
      <div style={row}>
        <span className="field-label">Logo</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
          <input name="company-logo" type="file" accept="image/*" onChange={onLogoFile} style={{ fontSize: 12, minWidth: 0 }} />
          {active.logo && (
            <>
              <img src={active.logo} alt="Company logo" style={{ width: 120, height: "auto", flex: "none", border: "1px solid var(--ink-faint)", background: "var(--well)" }} />
              <button onClick={removeLogo}
                style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11.5, padding: 0, whiteSpace: "nowrap" }}>Remove logo</button>
            </>
          )}
        </div>
        {logoErr && <p style={err}>{logoErr}</p>}
      </div>
      {saveFailed && <p style={err}>Couldn't save on this device</p>}
    </>
  );
}
