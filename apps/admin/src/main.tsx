import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { AppShell } from "@pulsarbot/ui-kit";
import { initTelegramMiniApp, readyTelegramMiniApp } from "./lib/telegram.js";
import { AdminDashboard } from "./pages/dashboard.js";
import "./index.css";

initTelegramMiniApp();

const queryClient = new QueryClient();

function AppRoot() {
  React.useEffect(() => {
    readyTelegramMiniApp();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell sidebar={<AdminDashboard.Sidebar />}>
        <Outlet />
      </AppShell>
    </QueryClientProvider>
  );
}

const rootRoute = createRootRoute({
  component: AppRoot,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AdminDashboard.Page,
});

const routeTree = rootRoute.addChildren([indexRoute]);
const router = createRouter({
  routeTree,
  basepath: "/miniapp",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
