import { useEffect, useRef } from "react";
import { Icon } from "../brand/icons.jsx";
import { PREMIUM_COMPARE, PREMIUM_PLANS, PREMIUM_SIGN_IN, PREMIUM_TRIAL, planHref, writePremiumPrompt } from "../lib/premiumPlans.js";
import "./premiumPlans.css";

// Pricing and sign-up sheet. Every link opens in a new tab so the takeoff in this one stays where it is.
export default function PremiumPlans({ onClose, onOpenChange }) {
  const dialog = useRef(null);
  useEffect(() => {
    const el = dialog.current, previous = document.activeElement; el.showModal(); onOpenChange(true);
    return () => { el.close(); onOpenChange(false); requestAnimationFrame(() => { const target = previous?.isConnected && previous !== document.body ? previous : document.querySelector("[data-premium-trigger]"); target?.focus(); }); };
  }, [onOpenChange]);
  const close = () => { writePremiumPrompt("dismissed"); onClose(); };
  const ext = { target: "_blank", rel: "noopener" };
  return <dialog ref={dialog} className="premium-plans-dialog" aria-labelledby="premium-plans-title" onKeyDown={e => e.stopPropagation()} onCancel={e => {e.preventDefault(); close();}}>
    <button className="premium-plans-close" type="button" aria-label="Close Premium plans" onClick={close}>×</button>
    <div className="premium-plans-emblem"><Icon name="product" size={28}/></div>
    <p className="premium-plans-eyebrow">OPENTAKEOFF PREMIUM · PRICING</p>
    <h2 id="premium-plans-title">Premium from ${PREMIUM_PLANS[0].price} a month.</h2>
    <p>Both Pro plans start with a {PREMIUM_TRIAL.days}-day free trial and {PREMIUM_TRIAL.credits} AI credits. Your card goes on file, and you pay $0 if you cancel before day {PREMIUM_TRIAL.days}.</p>
    <div className="premium-plans-grid">
      {PREMIUM_PLANS.map(plan => <section key={plan.id} className={`premium-plan${plan.hot ? " hot" : ""}`} aria-labelledby={`premium-plan-${plan.id}`}>
        <div className="premium-plan-head"><h3 id={`premium-plan-${plan.id}`}>{plan.name}</h3><span>{plan.tag}</span></div>
        <div className="premium-plan-price">{plan.price == null ? "Let’s talk" : <>${plan.price}<small>/month</small></>}</div>
        <div className="premium-plan-per">{plan.per}</div>
        <ul>{plan.features.map(f => <li key={f}>{f}</li>)}</ul>
        <a className={`premium-plan-cta${plan.hot ? " solid" : ""}`} href={planHref(plan)} {...ext}
          onClick={() => { if (plan.price != null) writePremiumPrompt("started"); }}>
          {plan.price == null ? "Contact us" : `Start ${PREMIUM_TRIAL.days}-day free trial`}</a>
      </section>)}
    </div>
    <p className="premium-plans-fine">Prices are per month plus applicable tax, billed monthly after the trial until you cancel. Premium is a separate hosted workspace; this app stays free, and your projects here stay in your browser.</p>
    <p className="premium-plans-links"><a href={PREMIUM_COMPARE} {...ext}>Compare every feature →</a><a href={PREMIUM_SIGN_IN} {...ext}>Already a customer? Sign in →</a></p>
  </dialog>;
}
