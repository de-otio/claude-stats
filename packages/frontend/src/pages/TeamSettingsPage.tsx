import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, Text, TextInput, Textarea, Select, SelectItem, Button, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";

export function TeamSettingsPage() {
  const { t } = useTranslation('frontend');
  const { slug = "" } = useParams<{ slug: string }>();

  const [name, setName] = useState("Backend Crew");
  const [description, setDescription] = useState("Our backend engineering team");
  const [leaderboardVisibility, setLeaderboardVisibility] = useState("team");
  const [crossTeamVisibility, setCrossTeamVisibility] = useState("summary");
  const [challengesEnabled, setChallengesEnabled] = useState(true);
  const [dashboardReaders, setDashboardReaders] = useState("");

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        to={`/team/${slug}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        &larr; {t('teamSettings.backToTeam')}
      </Link>

      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900">{t('teamSettings.title')}</h1>
        <Badge color="red" size="xs">{t('teamSettings.adminOnly')}</Badge>
      </div>

      {/* Team Identity */}
      <Card className="mb-4 space-y-4">
        <Text className="text-lg font-semibold text-gray-900">{t('teamSettings.teamIdentity')}</Text>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('teamSettings.teamName')}</label>
          <TextInput value={name} onValueChange={setName} placeholder={t('teamSettings.teamNamePlaceholder')} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('teamSettings.description')}</label>
          <Textarea
            value={description}
            onValueChange={setDescription}
            placeholder={t('teamSettings.descriptionPlaceholder')}
            rows={3}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('teamSettings.teamLogo')}</label>
          <Button variant="secondary" size="xs">
            {t('teamSettings.uploadLogo')}
          </Button>
          <Text className="mt-1 text-xs text-gray-400">{t('teamSettings.logoHint')}</Text>
        </div>
      </Card>

      {/* Visibility */}
      <Card className="mb-4 space-y-4">
        <Text className="text-lg font-semibold text-gray-900">{t('teamSettings.visibility')}</Text>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('teamSettings.leaderboardVisibility')}
          </label>
          <Select value={leaderboardVisibility} onValueChange={setLeaderboardVisibility}>
            <SelectItem value="private">{t('teamSettings.visibilityPrivateAdmins')}</SelectItem>
            <SelectItem value="team">{t('teamSettings.visibilityTeam')}</SelectItem>
            <SelectItem value="public">{t('teamSettings.visibilityPublic')}</SelectItem>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('teamSettings.crossTeamVisibility')}
          </label>
          <Select value={crossTeamVisibility} onValueChange={setCrossTeamVisibility}>
            <SelectItem value="none">{t('teamSettings.crossTeamNone')}</SelectItem>
            <SelectItem value="minimal">{t('teamSettings.crossTeamMinimal')}</SelectItem>
            <SelectItem value="summary">{t('teamSettings.crossTeamSummary')}</SelectItem>
          </Select>
          <Text className="mt-1 text-xs text-gray-400">
            {t('teamSettings.crossTeamHint')}
          </Text>
        </div>
      </Card>

      {/* Features */}
      <Card className="mb-4 space-y-3">
        <Text className="text-lg font-semibold text-gray-900">{t('teamSettings.features')}</Text>
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="challengesEnabled"
            checked={challengesEnabled}
            onChange={(e) => setChallengesEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <label htmlFor="challengesEnabled" className="text-sm text-gray-700">
            {t('teamSettings.enableChallenges')}
          </label>
        </div>
      </Card>

      {/* Dashboard Readers */}
      <Card className="mb-4 space-y-3">
        <Text className="text-lg font-semibold text-gray-900">{t('teamSettings.dashboardReaders')}</Text>
        <Text className="text-sm text-gray-500">
          {t('teamSettings.dashboardReadersHint')}
        </Text>
        <Textarea
          value={dashboardReaders}
          onValueChange={setDashboardReaders}
          placeholder={t('teamSettings.dashboardReadersPlaceholder')}
          rows={2}
        />
      </Card>

      {/* Danger Zone */}
      <Card className="mb-6 border border-red-200">
        <Text className="mb-4 text-lg font-semibold text-red-700">{t('teamSettings.dangerZone')}</Text>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-red-100 bg-red-50 p-4">
            <div>
              <Text className="font-medium text-red-800">{t('teamSettings.leaveTeam')}</Text>
              <Text className="text-sm text-red-600">
                {t('teamSettings.leaveTeamDescription')}
              </Text>
            </div>
            <Button color="red" variant="secondary" size="xs">
              {t('teamSettings.leaveTeam')}
            </Button>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-red-100 bg-red-50 p-4">
            <div>
              <Text className="font-medium text-red-800">{t('teamSettings.deleteTeam')}</Text>
              <Text className="text-sm text-red-600">
                {t('teamSettings.deleteTeamDescription')}
              </Text>
            </div>
            <Button color="red" variant="secondary" size="xs">
              {t('teamSettings.deleteTeam')}
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button>{t('teamSettings.saveChanges')}</Button>
      </div>
    </div>
  );
}
