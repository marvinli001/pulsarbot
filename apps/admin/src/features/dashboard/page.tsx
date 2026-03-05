import { Panel } from "@pulsarbot/ui-kit";
import { Settings2 } from "lucide-react";
import {
  selectionChanged,
  useTelegramBackButton,
  useTelegramClosingConfirmation,
  useTelegramMiniAppState,
  useTelegramSettingsButton,
} from "../../lib/telegram.js";
import { useAdminUiStore } from "../../lib/store.js";
import {
  Sidebar,
  navigation,
  useSessionBootstrap,
} from "./shared.js";
import {
  DocumentsPanel,
  HealthPanel,
  ImportExportPanel,
  LogsPanel,
  MarketPanel,
  McpServersPanel,
  MemoryPanel,
  OverviewPanel,
  ProfilesPanel,
  ProvidersPanel,
  SearchPanel,
  WorkspacePanel,
} from "./panels/index.js";

function Page() {
  const session = useSessionBootstrap();
  const telegram = useTelegramMiniAppState();
  const {
    activeSection,
    setActiveSection,
  } = useAdminUiStore();
  const requiresClosingConfirmation = activeSection !== "overview";
  const headerMutedText = "color-mix(in srgb, var(--app-header-text) 72%, transparent)";

  useTelegramBackButton(
    activeSection !== "overview"
      ? {
          isVisible: true,
          onClick: () => {
            selectionChanged();
            setActiveSection("overview");
          },
        }
      : {
          isVisible: false,
        },
  );
  useTelegramSettingsButton({
    isVisible: true,
    onClick: () => {
      if (activeSection !== "workspace") {
        selectionChanged();
        setActiveSection("workspace");
      }
    },
  });
  useTelegramClosingConfirmation(requiresClosingConfirmation);

  if (session.isPending) {
    return (
      <Panel title="Connecting" subtitle="Establishing the Telegram Mini App session.">
        <p className="text-sm text-slate-500">Loading session...</p>
      </Panel>
    );
  }

  if (session.isError) {
    return (
      <Panel title="Session Error" subtitle="The Mini App session could not be established.">
        <p className="text-sm text-rose-600">
          {session.error instanceof Error
            ? session.error.message
            : "Unknown session error"}
        </p>
      </Panel>
    );
  }

  return (
    <div className="min-w-0 space-y-4 md:space-y-6">
      <header
        className="overflow-hidden rounded-[20px] px-4 py-4 sm:rounded-[24px] sm:px-6 sm:py-5"
        style={{
          background: "var(--app-header-bg)",
          color: "var(--app-header-text)",
        }}
      >
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p
              className="text-xs uppercase tracking-[0.24em]"
              style={{ color: headerMutedText }}
            >
              Telegram Mini App
            </p>
            <h2 className="mt-2 break-words font-['Space_Grotesk',sans-serif] text-2xl font-semibold leading-tight sm:text-3xl">
              Pulsarbot Control Center
            </h2>
            <p className="mt-2 text-sm" style={{ color: headerMutedText }}>
              Owner: {session.data?.user?.username ?? session.data?.user?.userId ?? "Unknown"}
            </p>
            <p className="mt-2 text-xs" style={{ color: headerMutedText }}>
              {telegram.isTelegram
                ? `Telegram ${telegram.platform ?? "unknown"} · v${telegram.version ?? "?"} · ${Math.round(telegram.viewportHeight)}px`
                : "Browser preview mode"}
            </p>
          </div>
          <div
            className="w-full rounded-2xl px-3 py-2 text-xs sm:ml-auto sm:w-auto sm:rounded-full sm:px-4 sm:text-sm"
            style={{
              background: "color-mix(in srgb, var(--app-header-text) 10%, transparent)",
              color: "var(--app-header-text)",
            }}
          >
            <Settings2 className="mr-2 inline h-4 w-4 shrink-0" />
            {activeSection === "overview"
              ? "Railway single-service deployment"
              : navigation.find((item) => item.id === activeSection)?.label}
          </div>
        </div>
      </header>

      {activeSection === "overview" ? <OverviewPanel /> : null}
      {activeSection === "workspace" ? <WorkspacePanel /> : null}
      {activeSection === "providers" ? <ProvidersPanel /> : null}
      {activeSection === "profiles" ? <ProfilesPanel /> : null}
      {activeSection === "skills" ? <MarketPanel kind="skills" /> : null}
      {activeSection === "plugins" ? <MarketPanel kind="plugins" /> : null}
      {activeSection === "mcp-market" ? <MarketPanel kind="mcp" /> : null}
      {activeSection === "mcp-servers" ? <McpServersPanel /> : null}
      {activeSection === "search" ? <SearchPanel /> : null}
      {activeSection === "memory" ? <MemoryPanel /> : null}
      {activeSection === "documents" ? <DocumentsPanel /> : null}
      {activeSection === "import-export" ? <ImportExportPanel /> : null}
      {activeSection === "logs" ? <LogsPanel /> : null}
      {activeSection === "health" ? <HealthPanel /> : null}
    </div>
  );
}

export const AdminDashboard = {
  Sidebar,
  Page,
};
