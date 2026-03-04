import {
  useEffect,
  useState,
} from "react";
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Button,
  Input,
  Panel,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import {
  notificationOccurred,
  useTelegramMainButton,
} from "../../../lib/telegram.js";
import {
  CheckboxField,
  JsonPanel,
  MutationBadge,
  OrderedCheckboxListField,
  ResourceSelectField,
  fallbackStrategyOptions,
  searchProviderOptions,
  useSearchSettings,
} from "../shared.js";

export function SearchPanel() {
  const search = useSearchSettings();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    providerPriority: ["google_native", "bing_native", "exa_mcp", "web_browse"],
    allowNetwork: true,
    fallbackStrategy: "exa_then_browse",
    maxResults: "5",
  });

  useEffect(() => {
    if (search.data) {
      setForm({
        providerPriority: Array.isArray(search.data.providerPriority)
          ? search.data.providerPriority.map((item) => String(item))
          : ["google_native", "bing_native", "exa_mcp", "web_browse"],
        allowNetwork: Boolean(search.data.allowNetwork),
        fallbackStrategy: String(search.data.fallbackStrategy ?? "exa_then_browse"),
        maxResults: String(search.data.maxResults ?? "5"),
      });
    }
  }, [search.data]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/search/settings", {
        method: "PUT",
        body: JSON.stringify({
          providerPriority: form.providerPriority,
          allowNetwork: form.allowNetwork,
          fallbackStrategy: form.fallbackStrategy,
          maxResults: Number(form.maxResults || "5"),
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["search-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: () => notificationOccurred("error"),
  });

  useTelegramMainButton({
    text: "Save Search Settings",
    isVisible: true,
    isEnabled: !mutation.isPending,
    isProgressVisible: mutation.isPending,
    onClick: () => mutation.mutate(),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
      <Panel
        title="Search & Browse"
        subtitle="配置默认搜索优先级、联网开关和失败回退策略。"
        actions={<MutationBadge mutation={mutation} successLabel="Search Saved" />}
      >
        <div className="grid gap-3">
          <OrderedCheckboxListField
            label="Provider Priority"
            hint="勾选启用项，并用 Up / Down 调整顺序。只有真实可用的 provider 才会让 `search_web` 出现在运行时。"
            options={[...searchProviderOptions]}
            values={form.providerPriority}
            onChange={(next) => setForm((current) => ({ ...current, providerPriority: next }))}
          />
          <ResourceSelectField
            label="Fallback Strategy"
            hint="主链路全部失败后的行为。"
            value={form.fallbackStrategy}
            onChange={(next) => setForm((current) => ({ ...current, fallbackStrategy: next }))}
            options={[...fallbackStrategyOptions]}
          />
          <Input
            value={form.maxResults}
            onChange={(event) => setForm((current) => ({ ...current, maxResults: event.target.value }))}
            placeholder="max results"
          />
          <CheckboxField label="Allow Network Search" checked={form.allowNetwork} onChange={(next) => setForm((current) => ({ ...current, allowNetwork: next }))} />
          <div>
            <Button type="button" onClick={() => mutation.mutate()}>
              Save Search Settings
            </Button>
          </div>
        </div>
      </Panel>
      <JsonPanel
        title="Current Search Settings"
        subtitle="服务端持久化的 search_provider 配置。"
        value={search.data ?? {}}
      />
    </div>
  );
}
