import { useState } from "react";
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Button,
  Input,
  Panel,
  TextArea,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import {
  notificationOccurred,
  useTelegramMainButton,
} from "../../../lib/telegram.js";
import {
  JsonPanel,
  MutationBadge,
  formatJson,
} from "../shared.js";

export function ImportExportPanel() {
  const queryClient = useQueryClient();
  const [accessToken, setAccessToken] = useState("");
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [newAccessToken, setNewAccessToken] = useState("");
  const [bundleText, setBundleText] = useState("{}");

  const exportMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/settings/export", {
        method: "POST",
        body: JSON.stringify({
          accessToken,
          exportPassphrase,
        }),
      }),
    onSuccess: async (bundle) => {
      notificationOccurred("success");
      setBundleText(formatJson(bundle));
      await queryClient.invalidateQueries({ queryKey: ["system-logs"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const importMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/settings/import", {
        method: "POST",
        body: JSON.stringify({
          accessToken,
          importPassphrase,
          bundle: JSON.parse(bundleText),
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries();
    },
    onError: () => notificationOccurred("error"),
  });

  const rewrapMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/settings/rewrap-secrets", {
        method: "POST",
        body: JSON.stringify({
          accessToken,
          newAccessToken,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["system-logs"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const hasImportPayload = bundleText.trim() && bundleText.trim() !== "{}";
  const importExportMainButton =
    hasImportPayload && importPassphrase
      ? {
          text: "Import Bundle",
          isVisible: true,
          isEnabled: !importMutation.isPending,
          isProgressVisible: importMutation.isPending,
          onClick: () => importMutation.mutate(),
        }
      : newAccessToken
        ? {
            text: "Rewrap All Secrets",
            isVisible: true,
            isEnabled: !rewrapMutation.isPending,
            isProgressVisible: rewrapMutation.isPending,
            onClick: () => rewrapMutation.mutate(),
          }
        : {
            text: "Export Bundle",
            isVisible: true,
            isEnabled: !exportMutation.isPending,
            isProgressVisible: exportMutation.isPending,
            onClick: () => exportMutation.mutate(),
          };

  useTelegramMainButton(importExportMainButton);

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
      <Panel
        title="Import / Export"
        subtitle="高敏操作要求 access token；支持导出 bundle、导入恢复和重新包裹全部 secrets。"
      >
        <div className="grid gap-3">
          <Input
            type="password"
            placeholder="Current access token"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          <Input
            type="password"
            placeholder="Export passphrase"
            value={exportPassphrase}
            onChange={(event) => setExportPassphrase(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => exportMutation.mutate()}>
              Export Bundle
            </Button>
            <MutationBadge mutation={exportMutation} successLabel="Bundle Exported" />
          </div>
          <Input
            type="password"
            placeholder="Import passphrase"
            value={importPassphrase}
            onChange={(event) => setImportPassphrase(event.target.value)}
          />
          <TextArea
            value={bundleText}
            onChange={(event) => setBundleText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" tone="secondary" onClick={() => importMutation.mutate()}>
              Import Bundle
            </Button>
            <MutationBadge mutation={importMutation} successLabel="Bundle Imported" />
          </div>
          <Input
            type="password"
            placeholder="New access token for rewrap"
            value={newAccessToken}
            onChange={(event) => setNewAccessToken(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" tone="ghost" onClick={() => rewrapMutation.mutate()}>
              Rewrap All Secrets
            </Button>
            <MutationBadge mutation={rewrapMutation} successLabel="Secrets Rewrapped" />
          </div>
        </div>
      </Panel>
      <JsonPanel
        title="Bundle Preview"
        subtitle="导出的 bundle 会回填到这里，便于直接导入新实例。"
        value={JSON.parse(bundleText || "{}")}
      />
    </div>
  );
}
