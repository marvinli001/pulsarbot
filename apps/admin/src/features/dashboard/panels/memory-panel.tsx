import {
  useEffect,
  useState,
} from "react";
import {
  useMutation,
  useQuery,
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
  useMemoryDocuments,
  useMemoryStatus,
} from "../shared.js";

function readableErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : "Failed to load memory document";

  try {
    const parsed = JSON.parse(message) as { error?: string; message?: string };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      message = parsed.error.trim();
    } else if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      message = parsed.message.trim();
    }
  } catch {
    // Keep the original error message when it is not JSON.
  }

  return message;
}

export function MemoryPanel() {
  const memoryStatus = useMemoryStatus();
  const memoryDocuments = useMemoryDocuments();
  const queryClient = useQueryClient();
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [editorContent, setEditorContent] = useState("");

  useEffect(() => {
    if (!selectedDocumentId && memoryDocuments.data?.[0]?.id) {
      setSelectedDocumentId(String(memoryDocuments.data[0].id));
    }
  }, [memoryDocuments.data, selectedDocumentId]);

  const selectedDocumentQuery = useQuery({
    queryKey: ["memory-document", selectedDocumentId],
    queryFn: () =>
      apiFetch<JsonRecord>(`/api/memory/documents/${encodeURIComponent(selectedDocumentId)}`),
    enabled: Boolean(selectedDocumentId),
  });

  useEffect(() => {
    if (typeof selectedDocumentQuery.data?.content === "string") {
      setEditorContent(selectedDocumentQuery.data.content);
    }
  }, [selectedDocumentQuery.data]);

  const selectedDocumentError = readableErrorMessage(selectedDocumentQuery.error);

  const reindexMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/memory/reindex", {
        method: "POST",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["memory-status"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-documents"] });
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
      await queryClient.invalidateQueries({ queryKey: ["system-logs"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/memory/documents/${encodeURIComponent(selectedDocumentId)}`, {
        method: "PUT",
        body: JSON.stringify({
          content: editorContent,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["memory-status"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-documents"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-document", selectedDocumentId] });
      await queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: () => notificationOccurred("error"),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
      <div className="grid gap-6">
        <Panel
          title="Memory Layer"
          subtitle="展示 long-term / daily / document memory 的状态，并提供全量重建入口。"
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

        <Panel title="Memory Documents" subtitle="浏览 MEMORY.md、daily notes 和派生文档内容。">
          <div className="space-y-3">
            {memoryDocuments.data?.map((document) => {
              const active = String(document.id) === selectedDocumentId;
              return (
                <button
                  key={String(document.id)}
                  type="button"
                  onClick={() => setSelectedDocumentId(String(document.id))}
                  className="w-full rounded-2xl border p-4 text-left"
                  style={{
                    borderColor: active ? "var(--tg-button-color)" : "var(--app-border)",
                    background: active ? "rgba(15, 23, 42, 0.04)" : "var(--app-surface-soft)",
                  }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">
                        {String(document.title ?? document.path ?? document.id)}
                      </p>
                      <p className="text-sm text-slate-500">{String(document.path ?? "")}</p>
                    </div>
                    <Badge tone={active ? "success" : "neutral"}>
                      {String(document.kind ?? "unknown")}
                    </Badge>
                  </div>
                </button>
              );
            })}
            {!memoryDocuments.data?.length ? (
              <p className="text-sm text-slate-500">No memory documents available yet.</p>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="grid gap-6">
        <Panel
          title="Memory Editor"
          subtitle="可直接编辑选中的 memory 文本并触发索引刷新。"
          actions={<MutationBadge mutation={saveMutation} successLabel="Saved" />}
        >
          {selectedDocumentId ? (
            <div className="grid gap-3">
              {selectedDocumentQuery.isError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                  {selectedDocumentError}
                </div>
              ) : (
                <>
                  <TextArea
                    value={editorContent}
                    onChange={(event) => setEditorContent(event.target.value)}
                    className="min-h-[360px]"
                  />
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      disabled={saveMutation.isPending || selectedDocumentQuery.isPending}
                      onClick={() => saveMutation.mutate()}
                    >
                      Save Memory Content
                    </Button>
                    <Button
                      type="button"
                      tone="ghost"
                      onClick={() =>
                        setEditorContent(String(selectedDocumentQuery.data?.content ?? ""))
                      }
                    >
                      Reset Editor
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Select a memory document to inspect and edit it.</p>
          )}
        </Panel>

        <JsonPanel
          title="Selected Memory JSON"
          subtitle="包含文档元数据、contentHash 和当前正文。"
          value={selectedDocumentQuery.data ?? {}}
        />
      </div>
    </div>
  );
}
