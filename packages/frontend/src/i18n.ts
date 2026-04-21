import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from '../../core/src/locales/en/common.json';
import deCommon from '../../core/src/locales/de/common.json';
import jaCommon from '../../core/src/locales/ja/common.json';
import zhCnCommon from '../../core/src/locales/zh-CN/common.json';
import frCommon from '../../core/src/locales/fr/common.json';
import esCommon from '../../core/src/locales/es/common.json';
import ptBrCommon from '../../core/src/locales/pt-BR/common.json';
import plCommon from '../../core/src/locales/pl/common.json';
import ukCommon from '../../core/src/locales/uk/common.json';
import ruCommon from '../../core/src/locales/ru/common.json';
import enFrontend from '../../core/src/locales/en/frontend.json';
import deFrontend from '../../core/src/locales/de/frontend.json';
import jaFrontend from '../../core/src/locales/ja/frontend.json';
import zhCnFrontend from '../../core/src/locales/zh-CN/frontend.json';
import frFrontend from '../../core/src/locales/fr/frontend.json';
import esFrontend from '../../core/src/locales/es/frontend.json';
import ptBrFrontend from '../../core/src/locales/pt-BR/frontend.json';
import plFrontend from '../../core/src/locales/pl/frontend.json';
import ukFrontend from '../../core/src/locales/uk/frontend.json';
import ruFrontend from '../../core/src/locales/ru/frontend.json';

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
      ja: {
        common: jaCommon,
        frontend: jaFrontend,
      },
      'zh-CN': {
        common: zhCnCommon,
        frontend: zhCnFrontend,
      },
      fr: {
        common: frCommon,
        frontend: frFrontend,
      },
      es: {
        common: esCommon,
        frontend: esFrontend,
      },
      'pt-BR': {
        common: ptBrCommon,
        frontend: ptBrFrontend,
      },
      pl: {
        common: plCommon,
        frontend: plFrontend,
      },
      uk: {
        common: ukCommon,
        frontend: ukFrontend,
      },
      ru: {
        common: ruCommon,
        frontend: ruFrontend,
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
