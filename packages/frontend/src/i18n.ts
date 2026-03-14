import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from '../../core/src/locales/en/common.json';
import deCommon from '../../core/src/locales/de/common.json';
import enFrontend from '../../core/src/locales/en/frontend.json';
import deFrontend from '../../core/src/locales/de/frontend.json';

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    ns: ['frontend', 'common'],
    defaultNS: 'frontend',
    resources: {
      en: {
        common: enCommon,
        frontend: enFrontend,
      },
      de: {
        common: deCommon,
        frontend: deFrontend,
      },
    },
    detection: {
      order: ['querystring', 'localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18next;
