import { Card, Text, Button, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useMe, useUnlinkAccount, useUpdateAccountSharing } from "../hooks/useApi";

export function Accounts() {
  const { t } = useTranslation('frontend');
  const { data: me, isLoading } = useMe();
  const unlink = useUnlinkAccount();
  const updateSharing = useUpdateAccountSharing();

  const accounts = me?.accounts ?? [];
  // Accounts are provisioned device-side (the CLI/extension derives the HMAC
  // account id and links it); the web app cannot discover a raw account id, so
  // it manages sharing/unlinking of already-linked accounts only.

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('accounts.title')}</h1>
      </div>

      <Text className="mb-6 text-gray-600">
        {t('accounts.description')}
      </Text>

      {(unlink.isError || updateSharing.isError) && (
        <Text className="mb-4 text-sm text-red-600">
          {((unlink.error ?? updateSharing.error) as Error)?.message ?? "Update failed"}
        </Text>
      )}

      <div className="space-y-4">
        {accounts.map((account) => {
          const busy =
            (unlink.isPending && unlink.variables === account.accountId) ||
            (updateSharing.isPending &&
              updateSharing.variables?.accountId === account.accountId);
          return (
            <Card key={account.accountId}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Text className="font-semibold text-gray-900">{account.label}</Text>
                    <Badge color={account.shareWithTeams ? "green" : "gray"}>
                      {account.shareWithTeams ? t('accounts.shared') : t('accounts.private')}
                    </Badge>
                  </div>
                  <Text className="mt-1 font-mono text-xs text-gray-400">
                    {account.accountId}
                  </Text>
                </div>
                <Button
                  color="red"
                  variant="light"
                  size="xs"
                  disabled={busy}
                  onClick={() => unlink.mutate(account.accountId)}
                >
                  {t('accounts.unlink')}
                </Button>
              </div>

              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={account.shareWithTeams}
                    disabled={busy}
                    onChange={() =>
                      updateSharing.mutate({
                        accountId: account.accountId,
                        shareWithTeams: !account.shareWithTeams,
                      })
                    }
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <Text className="text-sm text-gray-700">
                    {t('accounts.includeInTeam')}
                  </Text>
                </div>
              </div>
            </Card>
          );
        })}

        {!isLoading && accounts.length === 0 && (
          <Card>
            <Text className="text-sm text-gray-500">{t('accounts.description')}</Text>
          </Card>
        )}
      </div>
    </div>
  );
}
