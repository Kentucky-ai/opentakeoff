import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import HttpBackend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";

const NAMESPACE = ["canvas", "report", "panels", "guide", "lib"];
const baseUrl = import.meta.env?.BASE_URL || "/";

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: ["en", "pt-br"],
    lowerCaseLng: true,
    ns: NAMESPACE,
    defaultNS: "canvas",
    interpolation: { escapeValue: false },
    backend: {
      loadPath: `${baseUrl}locales/{{lng}}/{{ns}}.json`,
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "i18nextLng",
      caches: ["localStorage"],
    },
  });

export default i18n;
