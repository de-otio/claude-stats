import { useState, useEffect } from "react";
import { Card, Text, TextInput, Select, SelectItem, Button } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useMe, useUpdateProfile } from "../hooks/useApi";

export function Profile() {
  const { t } = useTranslation('frontend');
  const { data: me } = useMe();
  const updateProfile = useUpdateProfile();
  const [displayName, setDisplayName] = useState("");
  const [defaultShareLevel, setDefaultShareLevel] = useState("summary");
  const [sharePrompts, setSharePrompts] = useState(false);

  // Seed the form from the loaded profile once.
  useEffect(() => {
    if (me?.displayName) setDisplayName(me.displayName);
  }, [me?.displayName]);

  useEffect(() => {
    if (me?.defaultShareLevel) setDefaultShareLevel(me.defaultShareLevel.toLowerCase());
  }, [me?.defaultShareLevel]);

  const handleSave = () => {
    updateProfile.mutate({
      displayName: displayName.trim(),
      defaultShareLevel: defaultShareLevel.toUpperCase(),
    });
  };

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
            <TextInput value={me?.email ?? ""} disabled />
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

      <div className="flex items-center justify-end gap-3">
        {updateProfile.isSuccess && (
          <Text className="text-sm text-green-600">{t('profile.saveChanges')} ✓</Text>
        )}
        {updateProfile.isError && (
          <Text className="text-sm text-red-600">
            {(updateProfile.error as Error)?.message ?? "Save failed"}
          </Text>
        )}
        <Button
          onClick={handleSave}
          disabled={!displayName.trim() || updateProfile.isPending}
          loading={updateProfile.isPending}
        >
          {t('profile.saveChanges')}
        </Button>
      </div>
    </div>
  );
}
