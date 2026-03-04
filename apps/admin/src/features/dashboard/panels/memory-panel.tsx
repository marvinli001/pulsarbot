import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Button,
  Panel,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import { notificationOccurred } from "../../../lib/telegram.js";
import {
  JsonPanel,
  KeyValueGrid,
  MutationBadge,
  type JsonRecord,
  useMemoryStatus,
} from "../shared.js";

export function MemoryPanel() {
  const memoryStatus = useMemoryStatus();
  const queryClient = useQueryClient();

  const reindexMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/memory/reindex", {
        method: "POST",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["memory-status"] });
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["system-logs"] });
    },
    onError: () => notificationOccurred("error"),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
      <Panel
        title="Memory Layer"
        subtitle="展示 long-term / daily memory、chunk 数量、storage 绑定和重建索引入口。"
        actions={<MutationBadge mutation={reindexMutation} successLabel="Reindexed" />}
      >
        <div className="grid gap-4">
          <KeyValueGrid
            items={[
              { label: "Documents", value: String(memoryStatus.data?.documents ?? 0) },
              { label: "Chunks", value: String(memoryStatus.data?.chunks ?? 0) },
              { label: "Pending Jobs", value: String(memoryStatus.data?.pendingJobs ?? 0) },
              {
                label: "Vectorize",
                value: String(
                  (memoryStatus.data?.storage as JsonRecord | undefined)?.vectorizeIndexName ??
                    "Not configured",
                ),
              },
            ]}
          />
          <div>
            <Button type="button" onClick={() => reindexMutation.mutate()}>
              Rebuild Memory Index
            </Button>
          </div>
        </div>
      </Panel>
      <JsonPanel
        title="Memory Status JSON"
        subtitle="包括 longterm、recentDaily、storage binding 与 pending jobs。"
        value={memoryStatus.data ?? {}}
      />
    </div>
  );
}
