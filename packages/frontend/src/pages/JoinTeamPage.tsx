import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, Text, TextInput, Select, SelectItem, Button } from "@tremor/react";
import { useTranslation } from "react-i18next";

const MOCK_ACCOUNTS = [
  { id: "acct_a1b2c3", label: "Personal" },
  { id: "acct_d4e5f6", label: "Work (Acme Corp)" },
];

export function JoinTeamPage() {
  const { t } = useTranslation('frontend');
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [shareLevel, setShareLevel] = useState("summary");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([MOCK_ACCOUNTS[0].id]);

  const toggleAccount = (id: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  const handleJoin = () => {
    // Derive a mock slug from the invite code
    const slug = code.toLowerCase().replace(/[^a-z0-9]/g, "-");
    navigate(`/team/${slug}`);
  };

  return (
    <div className="mx-auto max-w-lg p-6">
      <h1 className="mb-2 text-2xl font-bold text-gray-900">{t('joinTeam.title')}</h1>
      <Text className="mb-6 text-gray-600">{t('joinTeam.subtitle')}</Text>

      {/* Invite code highlight */}
      <div className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
        <Text className="text-xs font-semibold uppercase tracking-wide text-indigo-500">{t('joinTeam.inviteCode')}</Text>
        <Text className="mt-1 font-mono text-lg font-bold text-indigo-700">{code}</Text>
      </div>

      <Card className="mb-4">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('joinTeam.displayName')}</label>
            <TextInput
              value={displayName}
              onValueChange={setDisplayName}
              placeholder={t('joinTeam.displayNamePlaceholder')}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('joinTeam.shareLevel')}</label>
            <Select value={shareLevel} onValueChange={setShareLevel}>
              <SelectItem value="minimal">{t('joinTeam.shareLevelMinimal')}</SelectItem>
              <SelectItem value="summary">{t('joinTeam.shareLevelSummary')}</SelectItem>
              <SelectItem value="full">{t('joinTeam.shareLevelFull')}</SelectItem>
            </Select>
            <Text className="mt-1 text-xs text-gray-500">
              {t('joinTeam.shareLevelHint')}
            </Text>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">
              {t('joinTeam.accountsToInclude')}
            </label>
            <div className="space-y-2">
              {MOCK_ACCOUNTS.map((account) => (
                <div key={account.id} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id={account.id}
                    checked={selectedAccounts.includes(account.id)}
                    onChange={() => toggleAccount(account.id)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <label htmlFor={account.id} className="text-sm text-gray-700">
                    {account.label}
                    <span className="ml-2 font-mono text-xs text-gray-400">{account.id}</span>
                  </label>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Button className="w-full" onClick={handleJoin} disabled={!displayName.trim()}>
        {t('joinTeam.joinButton')}
      </Button>
    </div>
  );
}
