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
  JsonPanel,
  MutationBadge,
  useProfiles,
  useProviders,
  SelectField,
  useWorkspaceData,
} from "../shared.js";

export function WorkspacePanel() {
  const workspace = useWorkspaceData();
  const profiles = useProfiles();
  const providers = useProviders();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    label: "",
    timezone: "UTC",
    primaryModelProfileId: "",
    backgroundModelProfileId: "",
    activeAgentProfileId: "",
  });

  useEffect(() => {
    if (workspace.data?.workspace) {
      setForm({
        label: workspace.data.workspace.label,
        timezone: workspace.data.workspace.timezone,
        primaryModelProfileId: workspace.data.workspace.primaryModelProfileId ?? "",
        backgroundModelProfileId:
          workspace.data.workspace.backgroundModelProfileId ?? "",
        activeAgentProfileId:
          workspace.data.workspace.activeAgentProfileId ?? "",
      });
    }
  }, [workspace.data?.workspace]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/workspace", {
        method: "PUT",
        body: JSON.stringify({
          ...form,
          primaryModelProfileId: form.primaryModelProfileId || null,
          backgroundModelProfileId: form.backgroundModelProfileId || null,
          activeAgentProfileId: form.activeAgentProfileId || null,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: () => notificationOccurred("error"),
  });

  useTelegramMainButton({
    text: "Save Workspace",
    isVisible: true,
    isEnabled: !mutation.isPending,
    isProgressVisible: mutation.isPending,
    onClick: () => mutation.mutate(),
  });

  const providerOptions = [
    { value: "", label: "Not set" },
    ...((providers.data ?? [])
      .map((item) => {
        const id = typeof item.id === "string" ? item.id : "";
        if (!id) {
          return null;
        }
        const label = typeof item.label === "string" && item.label
          ? item.label
          : id;
        const kind = typeof item.kind === "string" ? item.kind : "provider";
        return {
          value: id,
          label: `${label} (${kind})`,
        };
      })
      .filter((item): item is { value: string; label: string } => Boolean(item))),
  ];

  const agentProfileOptions = [
    { value: "", label: "Not set" },
    ...((profiles.data ?? [])
      .map((item) => {
        const id = typeof item.id === "string" ? item.id : "";
        if (!id) {
          return null;
        }
        const label = typeof item.label === "string" && item.label
          ? item.label
          : id;
        return {
          value: id,
          label,
        };
      })
      .filter((item): item is { value: string; label: string } => Boolean(item))),
  ];

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr,0.95fr]">
      <Panel
        title="Workspace"
        subtitle="控制 owner 级工作区设置和默认 profile 指向。"
        actions={<MutationBadge mutation={mutation} successLabel="Workspace Saved" />}
      >
        <div className="grid gap-4">
          <Input
            placeholder="Workspace label"
            value={form.label}
            onChange={(event) =>
              setForm((current) => ({ ...current, label: event.target.value }))
            }
          />
          <Input
            placeholder="Timezone"
            value={form.timezone}
            onChange={(event) =>
              setForm((current) => ({ ...current, timezone: event.target.value }))
            }
          />
          <div className="grid gap-2">
            <p className="text-sm font-medium text-slate-900">Primary Provider Profile</p>
            <SelectField
              value={form.primaryModelProfileId}
              onChange={(next) =>
                setForm((current) => ({
                  ...current,
                  primaryModelProfileId: next,
                }))
              }
              options={providerOptions}
            />
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium text-slate-900">Background Provider Profile</p>
            <SelectField
              value={form.backgroundModelProfileId}
              onChange={(next) =>
                setForm((current) => ({
                  ...current,
                  backgroundModelProfileId: next,
                }))
              }
              options={providerOptions}
            />
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium text-slate-900">Active Agent Profile</p>
            <SelectField
              value={form.activeAgentProfileId}
              onChange={(next) =>
                setForm((current) => ({
                  ...current,
                  activeAgentProfileId: next,
                }))
              }
              options={agentProfileOptions}
            />
          </div>
          <div>
            <Button type="button" onClick={() => mutation.mutate()}>
              Save Workspace
            </Button>
          </div>
        </div>
      </Panel>
      <Panel
        title="Current Workspace Snapshot"
        subtitle="便于确认 profile id 与工作区实际绑定关系。"
      >
        <div className="grid gap-4">
          <JsonPanel
            title="Workspace"
            subtitle="当前已保存的 workspace JSON。"
            value={workspace.data?.workspace ?? {}}
          />
          <JsonPanel
            title="Provider Profiles"
            subtitle="可填写到 primary/background 字段的 provider profile 清单。"
            value={providers.data ?? []}
          />
          <JsonPanel
            title="Agent Profiles"
            subtitle="可填写到 activeAgentProfileId 的 agent profile 清单。"
            value={profiles.data ?? []}
          />
        </div>
      </Panel>
    </div>
  );
}
