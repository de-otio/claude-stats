import { useTranslation } from 'react-i18next';

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  return (
    <select
      value={i18n.language}
      onChange={e => i18n.changeLanguage(e.target.value)}
      className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
    >
      <option value="en">English</option>
      <option value="de">Deutsch</option>
    </select>
  );
}
