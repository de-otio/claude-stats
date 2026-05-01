import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Text, TextInput, Textarea, Select, SelectItem, Button } from "@tremor/react";
import { useTranslation } from "react-i18next";

export function CreateTeamPage() {
  const { t } = useTranslation('frontend');
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leaderboardVisibility, setLeaderboardVisibility] = useState("team");
  const [challengesEnabled, setChallengesEnabled] = useState(true);

  const handleCreate = () => {
    navigate("/teams");
  };

  return (
    <div className="mx-auto max-w-lg p-6">
      <h1 className="mb-2 text-2xl font-bold text-gray-900">{t('createTeam.title')}</h1>
      <Text className="mb-6 text-gray-600">{t('createTeam.subtitle')}</Text>

      <Card className="mb-4 space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('createTeam.teamName')}</label>
          <TextInput
            value={name}
            onValueChange={setName}
            placeholder={t('createTeam.teamNamePlaceholder')}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('createTeam.description')}</label>
          <Textarea
            value={description}
            onValueChange={setDescription}
            placeholder={t('createTeam.descriptionPlaceholder')}
            rows={3}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('createTeam.leaderboardVisibility')}
          </label>
          <Select value={leaderboardVisibility} onValueChange={setLeaderboardVisibility}>
            <SelectItem value="private">{t('createTeam.visibilityPrivate')}</SelectItem>
            <SelectItem value="team">{t('createTeam.visibilityTeam')}</SelectItem>
            <SelectItem value="public">{t('createTeam.visibilityPublic')}</SelectItem>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="challengesEnabled"
            checked={challengesEnabled}
            onChange={(e) => setChallengesEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <label htmlFor="challengesEnabled" className="text-sm text-gray-700">
            {t('createTeam.enableChallenges')}
          </label>
        </div>
      </Card>

      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={() => navigate("/teams")}>
          {t('createTeam.cancelButton')}
        </Button>
        <Button className="flex-1" onClick={handleCreate} disabled={!name.trim()}>
          {t('createTeam.createButton')}
        </Button>
      </div>
    </div>
  );
}
