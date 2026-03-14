import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

/**
 * Generic placeholder page used for routes that haven't been built yet.
 * Displays the page name so navigation can be verified.
 */
interface PlaceholderProps {
  name: string;
}

export function Placeholder({ name }: PlaceholderProps) {
  const { t } = useTranslation('frontend');
  const params = useParams();

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold text-gray-900">{name}</h1>
      <p className="mt-2 text-gray-600">{t('components.underConstruction')}</p>
      {Object.keys(params).length > 0 && (
        <div className="mt-4 rounded bg-gray-100 p-3 text-sm text-gray-700">
          <strong>{t('components.routeParams')}</strong>{" "}
          {Object.entries(params)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}
        </div>
      )}
    </div>
  );
}
