/**
 * Vitest setup file — initializes i18n so tests that call t() work correctly.
 */
import { initCliI18n } from "../i18n.js";

await initCliI18n("en");
