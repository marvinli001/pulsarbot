import {
  useEffect,
  useState,
} from "react";
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Badge,
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
  type CloudflareAuthMode,
  type CloudflareBootstrapMode,
  BootstrapModeCard,
  JsonPanel,
  KeyValueGrid,
  MutationBadge,
  ResourceSelectField,
  StatusTile,
  useCloudflareResources,
  useSessionBootstrap,
  useSystemHealth,
  useWorkspaceData,
} from "../shared.js";

export function OverviewPanel() {
  const session = useSessionBootstrap();
  const workspace = useWorkspaceData();
  const health = useSystemHealth();
  const resources = useCloudflareResources(
    Boolean(workspace.data?.bootstrapState.cloudflareConnected),
  );
  const queryClient = useQueryClient();
  const [accessToken, setAccessToken] = useState("");
  const [workspaceLabel, setWorkspaceLabel] = useState("Pulsarbot Workspace");
  const [timezone, setTimezone] = useState("UTC");
  const [cloudflareAuthMode, setCloudflareAuthMode] =
    useState<CloudflareAuthMode>("global_api_key");
  const [bootstrapMode, setBootstrapMode] =
    useState<CloudflareBootstrapMode>("new");
  const [cloudflareForm, setCloudflareForm] = useState({
    accountId: "",
    apiToken: "",
    globalApiKey: "",
    email: "",
    r2AccessKeyId: "",
    r2SecretAccessKey: "",
    vectorizeDimensions: "256",
  });
  const [resourceSelection, setResourceSelection] = useState({
    d1DatabaseId: "",
    r2BucketName: "",
    vectorizeIndexName: "",
    aiSearchIndexName: "",
  });

  const d1Resources = Array.isArray(resources.data?.d1) ? resources.data.d1 : [];
  const r2Resources = Array.isArray(resources.data?.r2) ? resources.data.r2 : [];
  const vectorizeResources = Array.isArray(resources.data?.vectorize)
    ? resources.data.vectorize
    : [];
  const aiSearchResources = Array.isArray(resources.data?.aiSearch)
    ? resources.data.aiSearch
    : [];

  useEffect(() => {
    if (!resources.data) {
      return;
    }
    const nextD1Resources = Array.isArray(resources.data.d1) ? resources.data.d1 : [];
    const nextR2Resources = Array.isArray(resources.data.r2) ? resources.data.r2 : [];
    const nextVectorizeResources = Array.isArray(resources.data.vectorize)
      ? resources.data.vectorize
      : [];
    const nextAiSearchResources = Array.isArray(resources.data.aiSearch)
      ? resources.data.aiSearch
      : [];

    setResourceSelection((current) => ({
      d1DatabaseId:
        current.d1DatabaseId ||
        (nextD1Resources.length === 1 ? nextD1Resources[0]?.uuid ?? "" : ""),
      r2BucketName:
        current.r2BucketName ||
        (nextR2Resources.length === 1 ? nextR2Resources[0]?.name ?? "" : ""),
      vectorizeIndexName:
        current.vectorizeIndexName ||
        (nextVectorizeResources.length === 1
          ? nextVectorizeResources[0]?.name ?? ""
          : ""),
      aiSearchIndexName:
        current.aiSearchIndexName ||
        (nextAiSearchResources.length === 1
          ? nextAiSearchResources[0]?.name ?? ""
          : ""),
    }));
  }, [resources.data]);

  const setCloudflareField = (
    key: keyof typeof cloudflareForm,
    value: string,
  ) => {
    setCloudflareForm((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const setResourceField = (
    key: keyof typeof resourceSelection,
    value: string,
  ) => {
    setResourceSelection((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const cloudflareReadyForConnect = Boolean(
    accessToken.trim() &&
      cloudflareForm.accountId.trim() &&
      (cloudflareAuthMode === "api_token"
        ? cloudflareForm.apiToken.trim()
        : cloudflareForm.globalApiKey.trim() && cloudflareForm.email.trim()),
  );

  const verifyMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/bootstrap/verify-access-token", {
        method: "POST",
        body: JSON.stringify({ accessToken }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const bindOwnerMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/bootstrap/bind-owner", {
        method: "POST",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const connectCloudflareMutation = useMutation({
    mutationFn: () => {
      if (!cloudflareForm.accountId.trim()) {
        throw new Error("Cloudflare Account ID is required");
      }
      const vectorizeDimensions = Number(cloudflareForm.vectorizeDimensions || "256");
      if (!Number.isFinite(vectorizeDimensions) || vectorizeDimensions <= 0) {
        throw new Error("Vectorize dimensions must be a positive number");
      }

      const payload: Record<string, unknown> = {
        accessToken,
        accountId: cloudflareForm.accountId.trim(),
        vectorizeDimensions,
      };

      if (cloudflareAuthMode === "api_token") {
        if (!cloudflareForm.apiToken.trim()) {
          throw new Error("Cloudflare API Token is required");
        }
        payload.apiToken = cloudflareForm.apiToken.trim();
      } else {
        if (!cloudflareForm.globalApiKey.trim() || !cloudflareForm.email.trim()) {
          throw new Error("Cloudflare email and Global API Key are required");
        }
        payload.globalApiKey = cloudflareForm.globalApiKey.trim();
        payload.email = cloudflareForm.email.trim();
      }

      if (cloudflareForm.r2AccessKeyId.trim()) {
        payload.r2AccessKeyId = cloudflareForm.r2AccessKeyId.trim();
      }
      if (cloudflareForm.r2SecretAccessKey.trim()) {
        payload.r2SecretAccessKey = cloudflareForm.r2SecretAccessKey.trim();
      }

      return apiFetch("/api/bootstrap/cloudflare/connect", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      await queryClient.invalidateQueries({ queryKey: ["cloudflare-resources"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const initWorkspaceMutation = useMutation({
    mutationFn: () => {
      if (bootstrapMode === "existing" && !resourceSelection.d1DatabaseId) {
        throw new Error("Select an existing D1 database before loading workspace data");
      }

      const selection = Object.fromEntries(
        Object.entries(resourceSelection).filter(([, value]) => value.trim().length > 0),
      );

      return apiFetch("/api/bootstrap/cloudflare/init-resources", {
        method: "POST",
        body: JSON.stringify({
          label: workspaceLabel,
          timezone,
          mode: bootstrapMode,
          ...(Object.keys(selection).length > 0 ? { selection } : {}),
        }),
      });
    },
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries();
    },
    onError: () => notificationOccurred("error"),
  });

  const bootstrapState =
    workspace.data?.bootstrapState ?? session.data?.bootstrapState;

  const bootstrapMainButton = !bootstrapState?.verified
    ? {
        text: "Verify Access Token",
        isVisible: true,
        isEnabled: Boolean(accessToken) && !verifyMutation.isPending,
        isProgressVisible: verifyMutation.isPending,
        onClick: () => verifyMutation.mutate(),
      }
    : !bootstrapState.ownerBound
      ? {
          text: "Bind Owner",
          isVisible: true,
          isEnabled: !bindOwnerMutation.isPending,
          isProgressVisible: bindOwnerMutation.isPending,
          onClick: () => bindOwnerMutation.mutate(),
        }
      : !bootstrapState.cloudflareConnected
        ? {
            text: "Connect Cloudflare",
            isVisible: true,
            isEnabled:
              cloudflareReadyForConnect && !connectCloudflareMutation.isPending,
            isProgressVisible: connectCloudflareMutation.isPending,
            onClick: () => connectCloudflareMutation.mutate(),
          }
        : !bootstrapState.resourcesInitialized
          ? {
              text:
                bootstrapMode === "existing"
                  ? "Load Existing Workspace"
                  : "Initialize New Workspace",
              isVisible: true,
              isEnabled:
                !initWorkspaceMutation.isPending &&
                (bootstrapMode === "new" || Boolean(resourceSelection.d1DatabaseId)),
              isProgressVisible: initWorkspaceMutation.isPending,
              onClick: () => initWorkspaceMutation.mutate(),
            }
          : null;

  useTelegramMainButton(bootstrapMainButton);

  const d1Options = [
    {
      value: "",
      label:
        bootstrapMode === "new"
          ? "Create a new D1 database"
          : "Select an existing D1 database",
    },
    ...d1Resources.map((database) => ({
      value: database.uuid,
      label: `${database.name} (${database.uuid})`,
    })),
  ];
  const r2Options = [
    {
      value: "",
      label:
        bootstrapMode === "new"
          ? "Create a new R2 bucket"
          : "Use saved or auto-created R2 bucket",
    },
    ...r2Resources.map((bucket) => ({
      value: bucket.name,
      label: bucket.name,
    })),
  ];
  const vectorizeOptions = [
    {
      value: "",
      label:
        bootstrapMode === "new"
          ? "Create a new Vectorize index"
          : "Use saved or auto-created Vectorize index",
    },
    ...vectorizeResources.map((index) => ({
      value: index.name,
      label: index.name,
    })),
  ];
  const aiSearchOptions = [
    {
      value: "",
      label: "Use saved or default AI Search instance",
    },
    ...aiSearchResources.map((index) => ({
      value: index.name,
      label: index.name,
    })),
  ];
  const discoveredResourceCounts = [
    { label: "D1 Databases", value: String(d1Resources.length) },
    { label: "R2 Buckets", value: String(r2Resources.length) },
    { label: "Vectorize", value: String(vectorizeResources.length) },
    { label: "AI Search", value: String(aiSearchResources.length) },
  ];

  return (
    <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
      <Panel
        title="Workspace Bootstrap"
        subtitle="首次进入时先校验访问令牌，再接入 Cloudflare 账号，并把 Pulsarbot 工作区配置落到 D1。"
      >
        <div className="grid gap-4 md:grid-cols-4">
          <StatusTile label="Access Token" ok={bootstrapState?.verified ?? false} />
          <StatusTile label="Owner" ok={bootstrapState?.ownerBound ?? false} />
          <StatusTile
            label="Cloudflare"
            ok={bootstrapState?.cloudflareConnected ?? false}
          />
          <StatusTile
            label="Resources"
            ok={bootstrapState?.resourcesInitialized ?? false}
          />
        </div>
        <div className="mt-6 grid gap-4">
          <Input
            type="password"
            placeholder="PULSARBOT_ACCESS_TOKEN"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => verifyMutation.mutate()}>
              Verify Access Token
            </Button>
            <Button
              type="button"
              tone="secondary"
              disabled={!bootstrapState?.verified}
              onClick={() => bindOwnerMutation.mutate()}
            >
              Bind Current Telegram User as Owner
            </Button>
            <MutationBadge mutation={verifyMutation} successLabel="Verified" />
            <MutationBadge mutation={bindOwnerMutation} successLabel="Owner Bound" />
          </div>
          <div
            className="rounded-2xl border p-4"
            style={{
              borderColor: "var(--app-border)",
              background: "var(--app-surface-soft)",
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Step 3</Badge>
              <p className="text-sm font-medium text-slate-900">
                Connect Cloudflare account
              </p>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              默认建议填 Cloudflare 账号的 Global API Key，用它直接发现并选择 D1、R2、Vectorize、AI Search 等实例。
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <BootstrapModeCard
                title="Global API Key"
                description="使用账号级全局凭证做控制面发现，适合首次接管现有 Pulsarbot 实例。"
                active={cloudflareAuthMode === "global_api_key"}
                onClick={() => setCloudflareAuthMode("global_api_key")}
              />
              <BootstrapModeCard
                title="API Token"
                description="使用 scoped API Token 做控制面操作，适合你已经准备好专用 Cloudflare token 的情况。"
                active={cloudflareAuthMode === "api_token"}
                onClick={() => setCloudflareAuthMode("api_token")}
              />
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Input
                placeholder="Cloudflare Account ID"
                value={cloudflareForm.accountId}
                onChange={(event) =>
                  setCloudflareField("accountId", event.target.value)
                }
              />
              {cloudflareAuthMode === "api_token" ? (
                <Input
                  type="password"
                  placeholder="Cloudflare API Token"
                  value={cloudflareForm.apiToken}
                  onChange={(event) =>
                    setCloudflareField("apiToken", event.target.value)
                  }
                />
              ) : (
                <Input
                  placeholder="Cloudflare account email"
                  value={cloudflareForm.email}
                  onChange={(event) => setCloudflareField("email", event.target.value)}
                />
              )}
              {cloudflareAuthMode === "global_api_key" ? (
                <Input
                  type="password"
                  placeholder="Cloudflare Global API Key"
                  value={cloudflareForm.globalApiKey}
                  onChange={(event) =>
                    setCloudflareField("globalApiKey", event.target.value)
                  }
                />
              ) : null}
              <Input
                placeholder="Vectorize dimensions"
                value={cloudflareForm.vectorizeDimensions}
                onChange={(event) =>
                  setCloudflareField("vectorizeDimensions", event.target.value)
                }
              />
              <Input
                placeholder="R2 Access Key ID (recommended)"
                value={cloudflareForm.r2AccessKeyId}
                onChange={(event) =>
                  setCloudflareField("r2AccessKeyId", event.target.value)
                }
              />
              <Input
                type="password"
                placeholder="R2 Secret Access Key (recommended)"
                value={cloudflareForm.r2SecretAccessKey}
                onChange={(event) =>
                  setCloudflareField("r2SecretAccessKey", event.target.value)
                }
              />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              R2 的 S3 数据面读写仍然需要 `r2AccessKeyId / r2SecretAccessKey`。没有这两个字段，记忆文件、导出包和文档资产无法真正写入 R2。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              tone="secondary"
              disabled={!cloudflareReadyForConnect}
              onClick={() => connectCloudflareMutation.mutate()}
            >
              Connect Cloudflare
            </Button>
            <MutationBadge
              mutation={connectCloudflareMutation}
              successLabel="Cloudflare Connected"
            />
          </div>
          <div
            className="rounded-2xl border p-4"
            style={{
              borderColor: "var(--app-border)",
              background: "var(--app-surface-soft)",
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">Step 4</Badge>
              <p className="text-sm font-medium text-slate-900">
                Choose workspace bootstrap mode
              </p>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              你可以接管一个已经在 Cloudflare D1 中运行的 Pulsarbot 实例，或者直接让 Pulsarbot 初始化一套全新的资源。
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <BootstrapModeCard
                title="Create New Workspace"
                description="创建新的 D1、R2、Vectorize 资源，并写入初始 workspace、provider 和 profile。"
                active={bootstrapMode === "new"}
                onClick={() => setBootstrapMode("new")}
              />
              <BootstrapModeCard
                title="Load Existing Workspace"
                description="选择已有 D1 数据库并接管现有 Pulsarbot 配置，不再把已有 workspace/provider 重置为默认值。"
                active={bootstrapMode === "existing"}
                onClick={() => setBootstrapMode("existing")}
              />
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Input
                placeholder="Workspace label"
                value={workspaceLabel}
                onChange={(event) => setWorkspaceLabel(event.target.value)}
              />
              <Input
                placeholder="Timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </div>
            <div className="mt-4">
              <KeyValueGrid items={discoveredResourceCounts} />
            </div>
            {bootstrapMode === "existing" &&
            d1Resources.length === 0 &&
            !resources.isLoading ? (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                当前账号下没有读到任何 D1 数据库。若这是首次部署，切到
                `Create New Workspace` 更合理。
              </div>
            ) : null}
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <ResourceSelectField
                label="D1 Database"
                hint="D1 会作为 Pulsarbot 的主配置数据库。接管已有实例时，这里必须选已有数据库。"
                value={resourceSelection.d1DatabaseId}
                onChange={(next) => setResourceField("d1DatabaseId", next)}
                options={d1Options}
              />
              <ResourceSelectField
                label="R2 Bucket"
                hint="用于记忆文件、导出包、文档和资产存储。"
                value={resourceSelection.r2BucketName}
                onChange={(next) => setResourceField("r2BucketName", next)}
                options={r2Options}
              />
              <ResourceSelectField
                label="Vectorize Index"
                hint="用于向量检索和记忆重建。"
                value={resourceSelection.vectorizeIndexName}
                onChange={(next) => setResourceField("vectorizeIndexName", next)}
                options={vectorizeOptions}
              />
              <ResourceSelectField
                label="AI Search"
                hint="可选。用于 Cloudflare AI Search / AutoRAG 检索。"
                value={resourceSelection.aiSearchIndexName}
                onChange={(next) => setResourceField("aiSearchIndexName", next)}
                options={aiSearchOptions}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => initWorkspaceMutation.mutate()}>
              {bootstrapMode === "existing"
                ? "Load Existing Workspace"
                : "Initialize New Workspace"}
            </Button>
            <MutationBadge mutation={initWorkspaceMutation} successLabel="Workspace Ready" />
          </div>
        </div>
      </Panel>
      <div className="grid gap-6">
        <Panel
          title="Cloudflare Discovery"
          subtitle="连接 Cloudflare 后，这里会显示当前账号下可见的实例数量，方便直接从管理台下拉选择。"
        >
          <div className="grid gap-4">
            <KeyValueGrid items={discoveredResourceCounts} />
            <div className="flex flex-wrap items-center gap-2">
              {resources.isLoading ? <Badge tone="warning">Loading resources</Badge> : null}
              {resources.isSuccess ? <Badge tone="success">Resources synced</Badge> : null}
              {resources.isError ? <Badge tone="danger">Resource sync failed</Badge> : null}
            </div>
          </div>
        </Panel>
        <JsonPanel
          title="Discovered Cloudflare Resources"
          subtitle="保留原始资源 JSON 作为调试兜底。"
          value={resources.data ?? {}}
        />
        <JsonPanel
          title="Live Health Snapshot"
          subtitle="服务端实时健康状态。"
          value={health.data ?? {}}
        />
      </div>
    </div>
  );
}
