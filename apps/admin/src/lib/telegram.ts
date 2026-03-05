import {
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

type TelegramColorScheme = "light" | "dark";

interface TelegramInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

interface TelegramThemeParams {
  bg_color?: string;
  secondary_bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
  bottom_bar_bg_color?: string;
}

interface TelegramBottomButton {
  isVisible?: boolean;
  isActive?: boolean;
  isProgressVisible?: boolean;
  setText(text: string): TelegramBottomButton;
  onClick(callback: () => void): TelegramBottomButton;
  offClick(callback: () => void): TelegramBottomButton;
  show(): TelegramBottomButton;
  hide(): TelegramBottomButton;
  enable(): TelegramBottomButton;
  disable(): TelegramBottomButton;
  showProgress(leaveActive?: boolean): TelegramBottomButton;
  hideProgress(): TelegramBottomButton;
  setParams?(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
    has_shine_effect?: boolean;
  }): TelegramBottomButton;
}

interface TelegramSettingsButton {
  isVisible?: boolean;
  onClick(callback: () => void): TelegramSettingsButton;
  offClick(callback: () => void): TelegramSettingsButton;
  show(): TelegramSettingsButton;
  hide(): TelegramSettingsButton;
}

interface TelegramBackButton {
  isVisible?: boolean;
  onClick(callback: () => void): TelegramBackButton;
  offClick(callback: () => void): TelegramBackButton;
  show(): TelegramBackButton;
  hide(): TelegramBackButton;
}

interface TelegramHapticFeedback {
  impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
  notificationOccurred(type: "error" | "success" | "warning"): void;
  selectionChanged(): void;
}

interface TelegramWebApp {
  version?: string;
  platform?: string;
  colorScheme?: TelegramColorScheme;
  initData?: string;
  initDataUnsafe?: {
    user?: {
      id?: number | string;
      username?: string;
    };
  };
  themeParams: TelegramThemeParams;
  viewportHeight?: number;
  viewportStableHeight?: number;
  isExpanded?: boolean;
  safeAreaInset?: TelegramInsets;
  contentSafeAreaInset?: TelegramInsets;
  MainButton: TelegramBottomButton;
  BackButton: TelegramBackButton;
  SettingsButton?: TelegramSettingsButton;
  HapticFeedback?: TelegramHapticFeedback;
  ready(): void;
  expand(): void;
  onEvent(eventType: string, handler: (payload?: unknown) => void): void;
  offEvent(eventType: string, handler: (payload?: unknown) => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export interface TelegramMiniAppState {
  isTelegram: boolean;
  isReady: boolean;
  platform: string | null;
  version: string | null;
  colorScheme: TelegramColorScheme;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  themeParams: TelegramThemeParams;
  safeAreaInset: Required<TelegramInsets>;
  contentSafeAreaInset: Required<TelegramInsets>;
}

export interface TelegramMainButtonConfig {
  text: string;
  isVisible?: boolean;
  isEnabled?: boolean;
  isProgressVisible?: boolean;
  hasShineEffect?: boolean;
  onClick?: () => void;
}

export interface TelegramBackButtonConfig {
  isVisible?: boolean;
  onClick?: () => void;
}

export interface TelegramSettingsButtonConfig {
  isVisible?: boolean;
  onClick?: () => void;
}

const DEFAULT_THEME: Required<TelegramThemeParams> = {
  bg_color: "#f5f0e5",
  secondary_bg_color: "#ffffff",
  text_color: "#0f172a",
  hint_color: "#64748b",
  link_color: "#2563eb",
  button_color: "#0f172a",
  button_text_color: "#ffffff",
  header_bg_color: "#0f172a",
  accent_text_color: "#0f766e",
  section_bg_color: "#ffffff",
  section_header_text_color: "#0f172a",
  subtitle_text_color: "#64748b",
  destructive_text_color: "#dc2626",
  bottom_bar_bg_color: "#ffffff",
};

const DEFAULT_INSETS: Required<TelegramInsets> = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
};

const listeners = new Set<() => void>();
let initialized = false;
let readyDispatched = false;
let mainButtonHandler: (() => void) | null = null;
let backButtonHandler: (() => void) | null = null;
let settingsButtonHandler: (() => void) | null = null;
let resizeHandlerAttached = false;

let snapshot: TelegramMiniAppState = {
  isTelegram: false,
  isReady: false,
  platform: null,
  version: null,
  colorScheme: "light",
  isExpanded: true,
  viewportHeight: typeof window === "undefined" ? 0 : window.innerHeight,
  viewportStableHeight: typeof window === "undefined" ? 0 : window.innerHeight,
  themeParams: DEFAULT_THEME,
  safeAreaInset: DEFAULT_INSETS,
  contentSafeAreaInset: DEFAULT_INSETS,
};

function normalizeColor(value: string | undefined, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed) || /^#[0-9a-f]{3}$/i.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function normalizeInsets(value: TelegramInsets | undefined): Required<TelegramInsets> {
  return {
    top: Number(value?.top ?? 0),
    bottom: Number(value?.bottom ?? 0),
    left: Number(value?.left ?? 0),
    right: Number(value?.right ?? 0),
  };
}

function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

function hasRealTelegramSession(webApp: TelegramWebApp | null): boolean {
  if (!webApp) {
    return false;
  }
  return Boolean(webApp.initData) || Boolean(webApp.initDataUnsafe?.user?.id);
}

function emit() {
  listeners.forEach((listener) => listener());
}

function setRootVar(name: string, value: string) {
  document.documentElement.style.setProperty(name, value);
}

function themeValue(
  params: TelegramThemeParams,
  key: keyof TelegramThemeParams,
  fallback: string,
) {
  return normalizeColor(params[key], fallback);
}

function applyThemeToDocument(
  colorScheme: TelegramColorScheme,
  params: TelegramThemeParams,
) {
  const webApp = hasRealTelegramSession(getWebApp()) ? getWebApp() : null;
  const bg = themeValue(params, "bg_color", DEFAULT_THEME.bg_color);
  const secondary = themeValue(
    params,
    "secondary_bg_color",
    DEFAULT_THEME.secondary_bg_color,
  );
  const section = themeValue(
    params,
    "section_bg_color",
    secondary,
  );
  const text = themeValue(params, "text_color", DEFAULT_THEME.text_color);
  const hint = themeValue(params, "hint_color", DEFAULT_THEME.hint_color);
  const header = themeValue(
    params,
    "header_bg_color",
    colorScheme === "dark" ? secondary : DEFAULT_THEME.header_bg_color,
  );
  const button = themeValue(
    params,
    "button_color",
    colorScheme === "dark" ? "#2ea6ff" : DEFAULT_THEME.button_color,
  );
  const buttonText = themeValue(
    params,
    "button_text_color",
    DEFAULT_THEME.button_text_color,
  );
  const accent = themeValue(
    params,
    "accent_text_color",
    colorScheme === "dark" ? "#7dd3fc" : DEFAULT_THEME.accent_text_color,
  );
  const subtitle = themeValue(
    params,
    "subtitle_text_color",
    hint,
  );
  const destructive = themeValue(
    params,
    "destructive_text_color",
    DEFAULT_THEME.destructive_text_color,
  );
  const bottomBar = themeValue(
    params,
    "bottom_bar_bg_color",
    section,
  );
  const sectionHeader = themeValue(
    params,
    "section_header_text_color",
    text,
  );
  const border = colorScheme === "dark" ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)";
  const overlay = colorScheme === "dark"
    ? "radial-gradient(circle at top left, rgba(125,211,252,0.18), transparent 35%), linear-gradient(135deg, #10151c, #141c28 55%, #12201b)"
    : "radial-gradient(circle at top left, rgba(255,214,173,0.35), transparent 35%), linear-gradient(135deg, #f5f0e5, #f1f6fb 55%, #eff4ef)";

  setRootVar("--tg-bg-color", bg);
  setRootVar("--tg-secondary-bg-color", secondary);
  setRootVar("--tg-text-color", text);
  setRootVar("--tg-hint-color", hint);
  setRootVar("--tg-link-color", themeValue(params, "link_color", DEFAULT_THEME.link_color));
  setRootVar("--tg-button-color", button);
  setRootVar("--tg-button-text-color", buttonText);
  setRootVar("--tg-header-bg-color", header);
  setRootVar("--tg-section-bg-color", section);
  setRootVar("--tg-section-header-text-color", sectionHeader);
  setRootVar("--tg-subtitle-text-color", subtitle);
  setRootVar("--tg-accent-text-color", accent);
  setRootVar("--tg-destructive-text-color", destructive);
  setRootVar("--tg-bottom-bar-bg-color", bottomBar);
  setRootVar("--app-shell-bg", overlay);
  setRootVar("--app-surface", section);
  setRootVar("--app-surface-soft", secondary);
  setRootVar("--app-border", border);
  setRootVar("--app-header-bg", header);
  setRootVar("--app-header-text", buttonText);
  setRootVar("--app-muted-text", subtitle);
  setRootVar("--app-subtle-text", hint);
  setRootVar("--app-success-bg", colorScheme === "dark" ? "rgba(16,185,129,0.16)" : "#d1fae5");
  setRootVar("--app-success-text", colorScheme === "dark" ? "#6ee7b7" : "#047857");
  setRootVar("--app-warning-bg", colorScheme === "dark" ? "rgba(245,158,11,0.18)" : "#fef3c7");
  setRootVar("--app-warning-text", colorScheme === "dark" ? "#fbbf24" : "#b45309");
  setRootVar("--app-danger-bg", colorScheme === "dark" ? "rgba(244,63,94,0.18)" : "#ffe4e6");
  setRootVar("--app-danger-text", destructive);
  document.documentElement.dataset.telegramColorScheme = colorScheme;
  document.documentElement.style.colorScheme = colorScheme;
  const themeMeta = document.querySelector("meta[name='theme-color']");
  if (themeMeta) {
    themeMeta.setAttribute("content", header);
  }
  try {
    webApp?.setHeaderColor?.(header);
    webApp?.setBackgroundColor?.(bg);
  } catch {
    // Ignore host color sync failures in preview browsers.
  }
}

function applyViewportToDocument(state: TelegramMiniAppState) {
  setRootVar("--app-viewport-height", `${state.viewportHeight}px`);
  setRootVar("--app-viewport-stable-height", `${state.viewportStableHeight}px`);
  setRootVar("--tg-safe-area-inset-top", `${state.safeAreaInset.top}px`);
  setRootVar("--tg-safe-area-inset-bottom", `${state.safeAreaInset.bottom}px`);
  setRootVar("--tg-safe-area-inset-left", `${state.safeAreaInset.left}px`);
  setRootVar("--tg-safe-area-inset-right", `${state.safeAreaInset.right}px`);
  setRootVar(
    "--tg-content-safe-area-inset-top",
    `${state.contentSafeAreaInset.top}px`,
  );
  setRootVar(
    "--tg-content-safe-area-inset-bottom",
    `${state.contentSafeAreaInset.bottom}px`,
  );
  setRootVar(
    "--tg-content-safe-area-inset-left",
    `${state.contentSafeAreaInset.left}px`,
  );
  setRootVar(
    "--tg-content-safe-area-inset-right",
    `${state.contentSafeAreaInset.right}px`,
  );
}

function updateSnapshot() {
  const webApp = getWebApp();
  const isTelegram = hasRealTelegramSession(webApp);

  snapshot = {
    isTelegram,
    isReady: isTelegram && readyDispatched,
    platform: isTelegram ? webApp?.platform ?? null : null,
    version: isTelegram ? webApp?.version ?? null : null,
    colorScheme: isTelegram ? webApp?.colorScheme ?? "light" : "light",
    isExpanded: isTelegram ? webApp?.isExpanded ?? true : true,
    viewportHeight: Number((isTelegram ? webApp?.viewportHeight : undefined) ?? window.innerHeight),
    viewportStableHeight: Number(
      (isTelegram ? webApp?.viewportStableHeight ?? webApp?.viewportHeight : undefined) ??
        window.innerHeight,
    ),
    themeParams: {
      ...DEFAULT_THEME,
      ...(isTelegram ? webApp?.themeParams ?? {} : {}),
    },
    safeAreaInset: normalizeInsets(isTelegram ? webApp?.safeAreaInset : undefined),
    contentSafeAreaInset: normalizeInsets(
      isTelegram ? webApp?.contentSafeAreaInset : undefined,
    ),
  };

  applyThemeToDocument(snapshot.colorScheme, snapshot.themeParams);
  applyViewportToDocument(snapshot);
  emit();
}

function attachWindowResizeFallback() {
  if (resizeHandlerAttached) {
    return;
  }
  const handleResize = () => {
    if (getWebApp()) {
      return;
    }
    updateSnapshot();
  };
  window.addEventListener("resize", handleResize);
  resizeHandlerAttached = true;
}

export function initTelegramMiniApp() {
  if (initialized) {
    return;
  }
  initialized = true;

  const webApp = getWebApp();
  updateSnapshot();
  attachWindowResizeFallback();

  if (!webApp) {
    return;
  }

  const sync = () => updateSnapshot();
  webApp.onEvent("themeChanged", sync);
  webApp.onEvent("viewportChanged", sync);
  webApp.onEvent("safeAreaChanged", sync);
  webApp.onEvent("contentSafeAreaChanged", sync);
  updateSnapshot();
}

export function readyTelegramMiniApp() {
  const webApp = getWebApp();
  if (!hasRealTelegramSession(webApp) || readyDispatched) {
    updateSnapshot();
    return;
  }
  readyDispatched = true;

  try {
    webApp?.ready();
  } catch {
    // Ignore client-side WebApp readiness errors in unsupported environments.
  }

  try {
    webApp?.expand();
  } catch {
    // Ignore if expand is unavailable.
  }

  updateSnapshot();
}

export function getTelegramMiniAppSnapshot() {
  return snapshot;
}

export function subscribeTelegramMiniApp(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTelegramMiniAppState() {
  return useSyncExternalStore(
    subscribeTelegramMiniApp,
    getTelegramMiniAppSnapshot,
    getTelegramMiniAppSnapshot,
  );
}

export function impactOccurred(
  style: "light" | "medium" | "heavy" | "rigid" | "soft" = "light",
) {
  if (!snapshot.isTelegram) {
    return;
  }
  getWebApp()?.HapticFeedback?.impactOccurred(style);
}

export function notificationOccurred(type: "error" | "success" | "warning") {
  if (!snapshot.isTelegram) {
    return;
  }
  getWebApp()?.HapticFeedback?.notificationOccurred(type);
}

export function selectionChanged() {
  if (!snapshot.isTelegram) {
    return;
  }
  getWebApp()?.HapticFeedback?.selectionChanged();
}

export function configureTelegramBackButton(
  config: TelegramBackButtonConfig | null,
) {
  const webApp = getWebApp();
  const backButton = webApp?.BackButton;
  if (!snapshot.isTelegram || !backButton) {
    return;
  }

  if (backButtonHandler) {
    backButton.offClick(backButtonHandler);
    backButtonHandler = null;
  }

  if (!config?.isVisible) {
    backButton.hide();
    return;
  }

  if (config.onClick) {
    backButtonHandler = () => {
      impactOccurred("light");
      config.onClick?.();
    };
    backButton.onClick(backButtonHandler);
  }

  backButton.show();
}

export function configureTelegramSettingsButton(
  config: TelegramSettingsButtonConfig | null,
) {
  const webApp = getWebApp();
  const settingsButton = webApp?.SettingsButton;
  if (!snapshot.isTelegram || !settingsButton) {
    return;
  }

  if (settingsButtonHandler) {
    settingsButton.offClick(settingsButtonHandler);
    settingsButtonHandler = null;
  }

  if (!config?.isVisible) {
    settingsButton.hide();
    return;
  }

  if (config.onClick) {
    settingsButtonHandler = () => {
      impactOccurred("light");
      config.onClick?.();
    };
    settingsButton.onClick(settingsButtonHandler);
  }

  settingsButton.show();
}

export function configureTelegramMainButton(
  config: TelegramMainButtonConfig | null,
) {
  const webApp = getWebApp();
  const mainButton = webApp?.MainButton;
  if (!snapshot.isTelegram || !mainButton) {
    return;
  }

  const suppressOnIos = snapshot.platform === "ios";
  if (suppressOnIos) {
    mainButton.hideProgress();
    mainButton.hide();
    return;
  }

  if (mainButtonHandler) {
    mainButton.offClick(mainButtonHandler);
    mainButtonHandler = null;
  }

  if (!config?.isVisible) {
    mainButton.hideProgress();
    mainButton.hide();
    return;
  }

  const color = themeValue(snapshot.themeParams, "button_color", DEFAULT_THEME.button_color);
  const textColor = themeValue(
    snapshot.themeParams,
    "button_text_color",
    DEFAULT_THEME.button_text_color,
  );

  if (mainButton.setParams) {
    mainButton.setParams({
      text: config.text,
      color,
      text_color: textColor,
      is_active: config.isEnabled ?? true,
      is_visible: true,
      has_shine_effect: config.hasShineEffect ?? true,
    });
  } else {
    mainButton.setText(config.text);
    if (config.isEnabled === false) {
      mainButton.disable();
    } else {
      mainButton.enable();
    }
    mainButton.show();
  }

  if (config.isProgressVisible) {
    mainButton.showProgress();
  } else {
    mainButton.hideProgress();
  }

  if (config.onClick) {
    mainButtonHandler = () => {
      impactOccurred("medium");
      config.onClick?.();
    };
    mainButton.onClick(mainButtonHandler);
  }
}

export function configureTelegramClosingConfirmation(enabled: boolean) {
  const webApp = getWebApp();
  if (!snapshot.isTelegram) {
    return;
  }
  if (enabled) {
    webApp?.enableClosingConfirmation?.();
    return;
  }
  webApp?.disableClosingConfirmation?.();
}

export function useTelegramBackButton(config: TelegramBackButtonConfig | null) {
  const onClickRef = useRef<TelegramBackButtonConfig["onClick"]>(config?.onClick);
  onClickRef.current = config?.onClick;

  useEffect(() => {
    if (!config?.isVisible) {
      configureTelegramBackButton(null);
      return;
    }
    const onClick = onClickRef.current
      ? () => {
          onClickRef.current?.();
        }
      : null;
    configureTelegramBackButton({
      isVisible: true,
      ...(onClick ? { onClick } : {}),
    });
  }, [config?.isVisible]);

  useEffect(
    () => () => {
      configureTelegramBackButton(null);
    },
    [],
  );
}

export function useTelegramSettingsButton(
  config: TelegramSettingsButtonConfig | null,
) {
  const onClickRef = useRef<TelegramSettingsButtonConfig["onClick"]>(config?.onClick);
  onClickRef.current = config?.onClick;

  useEffect(() => {
    if (!config?.isVisible) {
      configureTelegramSettingsButton(null);
      return;
    }
    const onClick = onClickRef.current
      ? () => {
          onClickRef.current?.();
        }
      : null;
    configureTelegramSettingsButton({
      isVisible: true,
      ...(onClick ? { onClick } : {}),
    });
  }, [config?.isVisible]);

  useEffect(
    () => () => {
      configureTelegramSettingsButton(null);
    },
    [],
  );
}

export function useTelegramMainButton(config: TelegramMainButtonConfig | null) {
  const onClickRef = useRef<TelegramMainButtonConfig["onClick"]>(config?.onClick);
  onClickRef.current = config?.onClick;

  useEffect(() => {
    if (!config) {
      configureTelegramMainButton(null);
      return;
    }

    const onClick = onClickRef.current
      ? () => {
          onClickRef.current?.();
        }
      : null;

    configureTelegramMainButton({
      ...config,
      ...(onClick ? { onClick } : {}),
    });
  }, [
    config?.text,
    config?.isVisible,
    config?.isEnabled,
    config?.isProgressVisible,
    config?.hasShineEffect,
  ]);

  useEffect(
    () => () => {
      configureTelegramMainButton(null);
    },
    [],
  );
}

export function useTelegramClosingConfirmation(enabled: boolean) {
  useEffect(() => {
    configureTelegramClosingConfirmation(enabled);
  }, [enabled]);

  useEffect(
    () => () => {
      configureTelegramClosingConfirmation(false);
    },
    [],
  );
}
