import { create } from "zustand";

type AdminSection =
  | "overview"
  | "workspace"
  | "providers"
  | "profiles"
  | "skills"
  | "plugins"
  | "mcp-market"
  | "mcp-servers"
  | "search"
  | "memory"
  | "documents"
  | "import-export"
  | "logs"
  | "health";

interface AdminUiState {
  activeSection: AdminSection;
  setActiveSection: (section: AdminSection) => void;
}

export const useAdminUiStore = create<AdminUiState>((set) => ({
  activeSection: "overview",
  setActiveSection: (activeSection) => set({ activeSection }),
}));
