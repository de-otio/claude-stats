import { useState } from "react";
import { Card, Text, TextInput, Select, SelectItem, Button } from "@tremor/react";
import { useTranslation } from "react-i18next";

export function Profile() {
  const { t } = useTranslation('frontend');
  const [displayName, setDisplayName] = useState("Alice Chen");
  const [defaultShareLevel, setDefaultShareLevel] = useState("summary");
  const [sharePrompts, setSharePrompts] = useState(false);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">{t('profile.title')}</h1>

      <Card className="mb-6">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('profile.personalInfo')}</Text>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('profile.displayName')}</label>
            <TextInput
              value={displayName}
              onValueChange={setDisplayName}
              placeholder={t('profile.displayNamePlaceholder')}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('profile.email')}</label>
            <TextInput value="alice@example.com" disabled />
            <Text className="mt-1 text-xs text-gray-500">{t('profile.emailReadonly')}</Text>
          </div>
        </div>
      </Card>

      <Card className="mb-6">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('profile.privacyPreferences')}</Text>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{t('profile.defaultShareLevel')}</label>
            <Select value={defaultShareLevel} onValueChange={setDefaultShareLevel}>
              <SelectItem value="minimal">{t('profile.shareLevelMinimal')}</SelectItem>
              <SelectItem value="summary">{t('profile.shareLevelSummary')}</SelectItem>
              <SelectItem value="full">{t('profile.shareLevelFull')}</SelectItem>
            </Select>
            <Text className="mt-1 text-xs text-gray-500">
              {t('profile.shareLevelHint')}
            </Text>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="sharePrompts"
              checked={sharePrompts}
              onChange={(e) => setSharePrompts(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="sharePrompts" className="text-sm text-gray-700">
              {t('profile.sharePrompts')}
            </label>
          </div>
        </div>
      </Card>

      <Card className="mb-6">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('profile.dangerZone')}</Text>
        <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-4">
          <div>
            <Text className="font-medium text-red-800">{t('profile.deleteAccount')}</Text>
            <Text className="text-sm text-red-600">
              {t('profile.deleteAccountDescription')}
            </Text>
          </div>
          <Button color="red" variant="secondary" size="xs">
            {t('profile.deleteAccount')}
          </Button>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button>{t('profile.saveChanges')}</Button>
      </div>
    </div>
  );
}
