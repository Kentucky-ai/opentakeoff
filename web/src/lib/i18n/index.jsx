import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage, setLanguage, localizeText } from "./core.js";
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