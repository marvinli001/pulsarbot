import { useState } from "react";
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Badge,
  Button,
  Panel,
  TextArea,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import { notificationOccurred } from "../../../lib/telegram.js";
import {
  JsonPanel,
  KeyValueGrid,
  MutationBadge,
  type JsonRecord,
  useDocuments,
} from "../shared.js";

export function DocumentsPanel() {
  const documents = useDocuments();
  const queryClient = useQueryClient();
  const [selectedDocument, setSelectedDocument] = useState<JsonRecord | null>(null);

  const inspectMutation = useMutation({
    mutationFn: (id: string) => apiFetch<JsonRecord>(`/api/documents/${id}`),
    onSuccess: (data) => setSelectedDocument(data),
    onError: () => notificationOccurred("error"),
  });

  const reindexMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/documents/${id}/reindex`, {
        method: "POST",
      }),
    onSuccess: async (_data, id) => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-status"] });
      if (selectedDocument?.id === id) {
        inspectMutation.mutate(id);
      }
    },
    onError: () => notificationOccurred("error"),
  });

  const reextractMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/documents/${id}/re-extract`, {
        method: "POST",
      }),
    onSuccess: async (_data, id) => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["system-logs"] });
      if (selectedDocument?.id === id) {
        inspectMutation.mutate(id);
      }
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
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge tone={document.extractionStatus === "completed" ? "success" : document.extractionStatus === "failed" ? "danger" : "warning"}>
                      {String(document.extractionStatus ?? "unknown")}
                    </Badge>
                    {document.extractionMethod ? (
                      <Badge tone="neutral">{String(document.extractionMethod)}</Badge>
                    ) : null}
                    <Badge tone={document.lastIndexedAt ? "success" : "warning"}>
                      {document.lastIndexedAt ? "Indexed" : "Not Indexed"}
                    </Badge>
                  </div>
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

      <div className="grid gap-6">
        <Panel
          title="Selected Document"
          subtitle="查看源文件、派生文本、抽取方法、失败原因和索引状态。"
          actions={
            <div className="flex gap-2">
              <MutationBadge mutation={inspectMutation} successLabel="Loaded" />
              <MutationBadge mutation={reextractMutation} successLabel="Queued" />
              <MutationBadge mutation={reindexMutation} successLabel="Reindexed" />
            </div>
          }
        >
          {selectedDocument ? (
            <div className="grid gap-4">
              <KeyValueGrid
                items={[
                  { label: "Title", value: String(selectedDocument.title ?? selectedDocument.id ?? "") },
                  { label: "Extraction Status", value: String(selectedDocument.extractionStatus ?? "unknown") },
                  { label: "Extraction Method", value: String(selectedDocument.extractionMethod ?? "none") },
                  { label: "Last Error", value: String(selectedDocument.lastExtractionError ?? "none") },
                  { label: "Last Extracted", value: String(selectedDocument.lastExtractedAt ?? "never") },
                  { label: "Last Indexed", value: String((selectedDocument.indexState as JsonRecord | undefined)?.lastIndexedAt ?? "never") },
                ]}
              />

              <div className="grid gap-2">
                <p className="text-sm font-medium text-slate-900">Source Preview</p>
                <TextArea readOnly value={String(selectedDocument.sourcePreview ?? "")} className="min-h-32" />
              </div>

              <div className="grid gap-2">
                <p className="text-sm font-medium text-slate-900">Derived Text</p>
                <TextArea readOnly value={String(selectedDocument.derivedText ?? "")} className="min-h-44" />
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Inspect a document to view its extraction and indexing details.</p>
          )}
        </Panel>

        <JsonPanel
          title="Document JSON"
          subtitle="原始 detail payload。"
          value={selectedDocument ?? {}}
        />
      </div>
    </div>
  );
}
