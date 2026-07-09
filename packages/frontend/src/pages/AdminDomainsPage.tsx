import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Text, TextInput, Button } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useAdminDomains, useUpdateAllowedDomains } from "../hooks/useApi";

export function AdminDomainsPage() {
  const { t } = useTranslation('frontend');
  const { data: domains, isLoading } = useAdminDomains();
  const update = useUpdateAllowedDomains();
  const [newDomain, setNewDomain] = useState("");

  const current = domains ?? [];
  const busy = update.isPending;

  const handleAdd = () => {
    const d = newDomain.trim().toLowerCase();
    if (!d || current.includes(d)) {
      setNewDomain("");
      return;
    }
    update.mutate([...current, d], { onSuccess: () => setNewDomain("") });
  };

  const handleRemove = (domain: string) => {
    update.mutate(current.filter((d) => d !== domain));
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

      {update.isError && (
        <Card className="mb-6 border-red-200 bg-red-50">
          <Text className="text-red-700">{(update.error as Error).message}</Text>
        </Card>
      )}

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
                  <th className="pb-3 font-medium text-gray-500" />
                </tr>
              </thead>
              <tbody>
                {current.map((domain) => (
                  <tr key={domain} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-3 pr-4 font-mono text-gray-800">{domain}</td>
                    <td className="py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleRemove(domain)}
                        disabled={busy}
                        className="text-sm text-red-600 hover:underline disabled:opacity-40"
                      >
                        {t('admin.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {current.length === 0 && (
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
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          />
          <Button onClick={handleAdd} loading={busy} disabled={!newDomain.trim() || busy}>
            {t('admin.addButton')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
