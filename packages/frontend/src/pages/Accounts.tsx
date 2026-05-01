import { useState } from "react";
import { Card, Text, Button, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";

interface LinkedAccount {
  accountId: string;
  label: string;
  shared: boolean;
  sharePrompts: boolean;
  linkedAt: string;
}

const MOCK_ACCOUNTS: LinkedAccount[] = [
  { accountId: "acct_a1b2c3", label: "Personal", shared: true, sharePrompts: false, linkedAt: "2026-02-15" },
  { accountId: "acct_d4e5f6", label: "Work (Acme Corp)", shared: true, sharePrompts: true, linkedAt: "2026-03-01" },
];

export function Accounts() {
  const { t } = useTranslation('frontend');
  const [accounts, setAccounts] = useState(MOCK_ACCOUNTS);

  const toggleShared = (id: string) => {
    setAccounts((prev) =>
      prev.map((a) => (a.accountId === id ? { ...a, shared: !a.shared } : a)),
    );
  };

  const toggleSharePrompts = (id: string) => {
    setAccounts((prev) =>
      prev.map((a) => (a.accountId === id ? { ...a, sharePrompts: !a.sharePrompts } : a)),
    );
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{t('accounts.title')}</h1>
        <Button size="xs">{t('accounts.linkNew')}</Button>
      </div>

      <Text className="mb-6 text-gray-600">
        {t('accounts.description')}
      </Text>

      <div className="space-y-4">
        {accounts.map((account) => (
          <Card key={account.accountId}>
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Text className="font-semibold text-gray-900">{account.label}</Text>
                  <Badge color={account.shared ? "green" : "gray"}>
                    {account.shared ? t('accounts.shared') : t('accounts.private')}
                  </Badge>
                </div>
                <Text className="mt-1 text-xs text-gray-500">
                  {t('accounts.idLabel', { id: account.accountId, date: account.linkedAt })}
                </Text>
              </div>
              <Button color="red" variant="light" size="xs">
                {t('accounts.unlink')}
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={account.shared}
                  onChange={() => toggleShared(account.accountId)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Text className="text-sm text-gray-700">
                  {t('accounts.includeInTeam')}
                </Text>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={account.sharePrompts}
                  onChange={() => toggleSharePrompts(account.accountId)}
                  className="h-4 w-4 rounded border-gray-300"
                  disabled={!account.shared}
                />
                <Text className="text-sm text-gray-700">
                  {t('accounts.allowViewPrompts')}
                </Text>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
