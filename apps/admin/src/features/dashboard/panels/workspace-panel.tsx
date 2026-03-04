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
  useWorkspaceData,
} from "../shared.js";

export function WorkspacePanel() {
  const workspace = useWorkspaceData();
  const profiles = useProfiles();
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
          <Input
            placeholder="Primary provider profile ID"
            value={form.primaryModelProfileId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                primaryModelProfileId: event.target.value,
              }))
            }
          />
          <Input
            placeholder="Background provider profile ID"
            value={form.backgroundModelProfileId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                backgroundModelProfileId: event.target.value,
              }))
            }
          />
          <Input
            placeholder="Active agent profile ID"
            value={form.activeAgentProfileId}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                activeAgentProfileId: event.target.value,
              }))
            }
          />
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
            title="Available Profiles"
            subtitle="可填写到 activeAgentProfileId 的 profile 清单。"
            value={profiles.data ?? []}
          />
        </div>
      </Panel>
    </div>
  );
}
