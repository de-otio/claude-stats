import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Text, TextInput, Button } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useAdminDomains } from "../hooks/useApi";

export function AdminDomainsPage() {
  const { t } = useTranslation('frontend');
  const { data: domains, isLoading } = useAdminDomains();
  const [newDomain, setNewDomain] = useState("");

  const handleAdd = () => {
    // No real submission yet — just clear the field
    setNewDomain("");
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        to="/admin"
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        &larr; {t('admin.backToAdmin')}
      </Link>

      <h1 className="mb-2 text-2xl font-bold text-gray-900">{t('admin.domainsTitle')}</h1>
      <Text className="mb-6 text-gray-500">
        {t('admin.domainsSubtitle')}
      </Text>

      {/* Domain Table */}
      <Card className="mb-6">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('admin.headerDomain')}</th>
                  <th className="pb-3 font-medium text-gray-500">{t('admin.headerAdded')}</th>
                </tr>
              </thead>
              <tbody>
                {(domains ?? []).map((d) => (
                  <tr key={d.domain} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-3 pr-4 font-mono text-gray-800">{d.domain}</td>
                    <td className="py-3 text-gray-500">
                      {new Date(d.addedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(domains ?? []).length === 0 && (
              <Text className="py-8 text-center text-gray-400">{t('admin.noDomains')}</Text>
            )}
          </div>
        )}
      </Card>

      {/* Add Domain Form */}
      <Card>
        <Text className="mb-3 font-semibold text-gray-900">{t('admin.addDomain')}</Text>
        <div className="flex gap-2">
          <TextInput
            value={newDomain}
            onValueChange={setNewDomain}
            placeholder={t('admin.addDomainPlaceholder')}
            className="flex-1"
          />
          <Button onClick={handleAdd} disabled={!newDomain.trim()}>
            {t('admin.addButton')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
