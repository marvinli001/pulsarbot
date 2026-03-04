import { useState } from "react";
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
  MutationBadge,
  useDocuments,
} from "../shared.js";

export function DocumentsPanel() {
  const documents = useDocuments();
  const queryClient = useQueryClient();
  const [selectedDocument, setSelectedDocument] = useState<unknown>(null);

  const inspectMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/documents/${id}`),
    onSuccess: (data) => setSelectedDocument(data),
    onError: () => notificationOccurred("error"),
  });

  const reindexMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/documents/${id}/reindex`, {
        method: "POST",
      }),
    onSuccess: async (data, id) => {
      notificationOccurred("success");
      setSelectedDocument(
        (current: unknown) => current ?? { id, reindex: data },
      );
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-status"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const reextractMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/documents/${id}/re-extract`, {
        method: "POST",
      }),
    onSuccess: async (data, id) => {
      notificationOccurred("success");
      setSelectedDocument(
        (current: unknown) => current ?? { id, reextract: data },
      );
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["system-logs"] });
    },
    onError: () => notificationOccurred("error"),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr,1fr]">
      <Panel title="Documents" subtitle="Telegram 文件、导入文档和衍生元数据都会出现在这里。">
        <div className="space-y-3">
          {documents.data?.map((document) => (
            <div key={String(document.id)} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-medium">{String(document.title ?? document.id)}</p>
                  <p className="text-sm text-slate-500">
                    {String(document.kind ?? "")} · {String(document.sourceType ?? "")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" tone="secondary" onClick={() => inspectMutation.mutate(String(document.id))}>
                    Inspect
                  </Button>
                  <Button type="button" tone="ghost" onClick={() => reextractMutation.mutate(String(document.id))}>
                    Re-extract
                  </Button>
                  <Button type="button" tone="ghost" onClick={() => reindexMutation.mutate(String(document.id))}>
                    Reindex
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {!documents.data?.length ? (
            <p className="text-sm text-slate-500">No documents indexed yet.</p>
          ) : null}
        </div>
      </Panel>
      <JsonPanel
        title="Selected Document"
        subtitle="查看文档元数据，或检查单文档重建索引结果。"
        value={selectedDocument ?? {}}
        actions={
          <div className="flex gap-2">
            <MutationBadge mutation={inspectMutation} successLabel="Loaded" />
            <MutationBadge mutation={reextractMutation} successLabel="Queued" />
            <MutationBadge mutation={reindexMutation} successLabel="Reindexed" />
          </div>
        }
      />
    </div>
  );
}
