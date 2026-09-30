import { useEffect, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { PREMIUM_FORM, ROLES, premiumPayload, sendPremiumInterest, writePremiumPrompt } from "../lib/premiumInterest.js";
import "./premiumInterest.css";

export default function PremiumInterest({ onClose, onOpenChange }) {
  const dialog = useRef(null), busy = useRef(false), requestId = useRef(crypto.randomUUID());
  const [state, setState] = useState("idle"), [error, setError] = useState("");
  const [available] = useState(() => {
    const definition = document.querySelector(`form[name="${PREMIUM_FORM}"][hidden]`);
    return !!definition && !definition.hasAttribute("data-netlify") && !!definition.querySelector('input[name="form-name"]');
  });
  useEffect(() => {
    const el = dialog.current, previous = document.activeElement; el.showModal(); onOpenChange(true);
    return () => { el.close(); onOpenChange(false); requestAnimationFrame(() => { const target = previous?.isConnected && previous !== document.body ? previous : document.querySelector("[data-premium-trigger]"); target?.focus(); }); };
  }, [onOpenChange]);
  const close = () => { if (busy.current) return; writePremiumPrompt("dismissed"); onClose(); };
  const submit = async (event) => {
    event.preventDefault();
    if (busy.current || !available) return;
    setError("");
    try {
      const payload = premiumPayload(Object.fromEntries(new FormData(event.currentTarget)), requestId.current);
      busy.current = true; setState("sending");
      await sendPremiumInterest(payload);
      writePremiumPrompt("requested"); setState("success");
    } catch (e) { setError(e.name === "TimeoutError" ? "The connection timed out. Your entries are still here; please try again." : e.message); setState("idle"); }
    finally { busy.current = false; }
  };
  return <dialog ref={dialog} className="premium-interest-dialog" aria-labelledby="premium-interest-title" onKeyDown={e => e.stopPropagation()} onCancel={e => {e.preventDefault(); close();}}>
    <button className="premium-interest-close" type="button" aria-label="Close premium interest form" disabled={state === "sending"} onClick={close}>×</button>
    <div className="premium-interest-emblem"><Icon name="product" size={28}/></div>
    <p className="premium-interest-eyebrow">OPENTAKEOFF PREMIUM · EARLY ACCESS</p>
    <h2 id="premium-interest-title">{state === "success" ? "You’re on the list." : "Unlock your next level of takeoff."}</h2>
    {state === "success" ? <div role="status"><p>Thanks for sharing what you need. We’ll contact you at the email you provided about early access.</p><button className="premium-interest-submit" onClick={close}>Back to your takeoff</button></div> : <>
      <p>Request early access to mobile and tablet workflows, advanced computer vision, estimates, proposals, RFIs and submittals.</p>
      <div className="premium-interest-capabilities" aria-label="Premium capabilities in development">
        <div><strong>Mobile &amp; tablet</strong><span>Take your work into the field.</span></div>
        <div><strong>Advanced CV models</strong><span>More help reading and measuring plans.</span></div>
        <div><strong>Estimates &amp; pricing</strong><span>Turn quantities into a priced scope.</span></div>
        <div><strong>Proposals</strong><span>Prepare client-ready deliverables.</span></div>
        <div><strong>RFI workflows</strong><span>Track questions and coordinate answers.</span></div>
        <div><strong>Submittals</strong><span>Build and track approval packages.</span></div>
      </div>
      <form name="premium-interest-ui" onSubmit={submit} aria-busy={state === "sending"}>
        <fieldset disabled={state === "sending"}>
          <label>Email <input type="email" name="email" autoComplete="email" maxLength={254} placeholder="you@company.com" required /></label>
          <div className="premium-interest-grid"><label>Name<input name="name" autoComplete="name" maxLength={100} required /></label><label>Company<input name="company" autoComplete="organization" maxLength={160} required /></label></div>
          <label>Your role<select name="role" required defaultValue=""><option value="" disabled>Choose a role</option>{ROLES.map(value => <option key={value}>{value}</option>)}</select></label>
          <label hidden>Leave this empty<input name="bot-field" tabIndex={-1} autoComplete="off"/></label>
          <p className="premium-interest-fine">We’ll use these details to respond about early access. All details pending.</p>
          {!available && <p role="status" className="premium-interest-fine">Form preview. Submissions become available on the hosted site after form setup.</p>}
          {error && <p role="alert" className="premium-interest-error">{error}</p>}
          <button className="premium-interest-submit" type="submit" disabled={!available || state === "sending"}>{state === "sending" ? "Sending your request…" : "Request Premium access"}</button>
        </fieldset>
      </form>
    </>}
  </dialog>;
}
