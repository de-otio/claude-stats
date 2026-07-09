import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Card, Text, TextInput, Select, SelectItem, Button, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import {
  useTeamSettings,
  useUpdateTeamSettings,
  useLeaveTeam,
  useDeleteTeam,
} from "../hooks/useApi";

export function TeamSettingsPage() {
  const { t } = useTranslation('frontend');
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const { data: team } = useTeamSettings(slug);
  const updateSettings = useUpdateTeamSettings();
  const leaveTeam = useLeaveTeam();
  const deleteTeam = useDeleteTeam();

  const isAdmin = team?.myRole === "ADMIN";

  // leaderboardEnabled is a boolean server-side; expose it as private-vs-team.
  const [leaderboard, setLeaderboard] = useState("team");
  // crossTeamVisibility maps directly to the CrossTeamVisibility enum.
  const [crossTeam, setCrossTeam] = useState("PRIVATE");
  const [challenges, setChallenges] = useState(true);

  // Seed the form once the real settings load.
  useEffect(() => {
    if (!team) return;
    setLeaderboard(team.settings.leaderboardEnabled ? "team" : "private");
    setCrossTeam(team.settings.crossTeamVisibility);
    setChallenges(team.settings.challengesEnabled);
  }, [team]);

  const handleSave = () => {
    if (!team) return;
    updateSettings.mutate({
      teamId: team.teamId,
      input: {
        leaderboardEnabled: leaderboard !== "private",
        crossTeamVisibility: crossTeam,
        challengesEnabled: challenges,
        // Preserve the server value we didn't surface in the form.
        minMembersForAggregates: team.settings.minMembersForAggregates,
      },
    });
  };

  const handleLeave = () => {
    if (!team) return;
    leaveTeam.mutate(team.teamId, { onSuccess: () => navigate("/teams") });
  };

  const handleDelete = () => {
    if (!team) return;
    deleteTeam.mutate(team.teamId, { onSuccess: () => navigate("/teams") });
  };

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
        {isAdmin && <Badge color="red" size="xs">{t('teamSettings.adminOnly')}</Badge>}
      </div>

      {/* Team Identity — name is set at creation and not renamable here. */}
      <Card className="mb-4 space-y-4">
        <Text className="text-lg font-semibold text-gray-900">{t('teamSettings.teamIdentity')}</Text>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('teamSettings.teamName')}</label>
          <TextInput value={team?.teamName ?? ""} disabled />
        </div>
      </Card>

      {/* Visibility */}
      <Card className="mb-4 space-y-4">
        <Text className="text-lg font-semibold text-gray-900">{t('teamSettings.visibility')}</Text>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('teamSettings.leaderboardVisibility')}
          </label>
          <Select value={leaderboard} onValueChange={setLeaderboard} disabled={!isAdmin}>
            <SelectItem value="private">{t('teamSettings.visibilityPrivateAdmins')}</SelectItem>
            <SelectItem value="team">{t('teamSettings.visibilityTeam')}</SelectItem>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('teamSettings.crossTeamVisibility')}
          </label>
          <Select value={crossTeam} onValueChange={setCrossTeam} disabled={!isAdmin}>
            <SelectItem value="PRIVATE">{t('teamSettings.crossTeamNone')}</SelectItem>
            <SelectItem value="PUBLIC_STATS">{t('teamSettings.crossTeamMinimal')}</SelectItem>
            <SelectItem value="PUBLIC_DASHBOARD">{t('teamSettings.crossTeamSummary')}</SelectItem>
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
            checked={challenges}
            disabled={!isAdmin}
            onChange={(e) => setChallenges(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <label htmlFor="challengesEnabled" className="text-sm text-gray-700">
            {t('teamSettings.enableChallenges')}
          </label>
        </div>
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
            <Button
              color="red"
              variant="secondary"
              size="xs"
              loading={leaveTeam.isPending}
              onClick={handleLeave}
            >
              {t('teamSettings.leaveTeam')}
            </Button>
          </div>
          {isAdmin && (
            <div className="flex items-center justify-between rounded-lg border border-red-100 bg-red-50 p-4">
              <div>
                <Text className="font-medium text-red-800">{t('teamSettings.deleteTeam')}</Text>
                <Text className="text-sm text-red-600">
                  {t('teamSettings.deleteTeamDescription')}
                </Text>
              </div>
              <Button
                color="red"
                variant="secondary"
                size="xs"
                loading={deleteTeam.isPending}
                onClick={handleDelete}
              >
                {t('teamSettings.deleteTeam')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {updateSettings.isSuccess && (
          <Text className="text-sm text-green-600">{t('teamSettings.saveChanges')} ✓</Text>
        )}
        {(updateSettings.isError || leaveTeam.isError || deleteTeam.isError) && (
          <Text className="text-sm text-red-600">
            {((updateSettings.error ?? leaveTeam.error ?? deleteTeam.error) as Error)?.message ??
              "Action failed"}
          </Text>
        )}
        <Button onClick={handleSave} disabled={!isAdmin || updateSettings.isPending} loading={updateSettings.isPending}>
          {t('teamSettings.saveChanges')}
        </Button>
      </div>
    </div>
  );
}
