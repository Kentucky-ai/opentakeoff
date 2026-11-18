import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage, setLanguage, localizeText, hasLanguageChoice } from "./core.js";
export { LANGUAGE_KEY, setLanguage } from "./core.js";
export function useTranslation() {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, () => "en");
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const t = useCallback((text) => language === "ru" ? localizeText(text) : text, [language]);
  return { t, language, setLanguage };
}
export function LanguageSwitcher() {
  const { language, setLanguage } = useTranslation();
  return <label className="ot-language-switcher"><span aria-hidden="true">EN / RU</span>
    <select aria-label="Interface language / Язык интерфейса" value={language}
      onChange={(event) => setLanguage(event.target.value)}>
      <option value="en" lang="en">English</option><option value="ru" lang="ru">Русский</option>
    </select></label>;
}
/** First visit: a small, non-blocking card to pick the interface language. English stays the default. */
export function FirstRunLanguage() {
  const [open, setOpen] = useState(() => !hasLanguageChoice());
  if (!open) return null;
  const pick = (lang) => { setLanguage(lang); setOpen(false); };
  return <div className="ot-first-language" role="dialog" aria-label="Choose your language / Выберите язык">
    <span>Choose your language · Выберите язык</span>
    <button type="button" lang="en" onClick={() => pick("en")}>English</button>
    <button type="button" lang="ru" onClick={() => pick("ru")}>Русский</button>
  </div>;
}
