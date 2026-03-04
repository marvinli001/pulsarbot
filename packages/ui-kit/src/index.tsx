import { clsx } from "clsx";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

function join(...parts: Array<string | false | null | undefined>) {
  return clsx(parts);
}

export function AppShell({
  sidebar,
  children,
}: PropsWithChildren<{ sidebar: ReactNode }>) {
  return (
    <div
      className="min-h-screen w-full overflow-x-hidden text-slate-900"
      style={{
        minHeight: "var(--app-viewport-stable-height, 100dvh)",
        background: "var(--app-shell-bg)",
        color: "var(--tg-text-color)",
      }}
    >
      <div
        className="mx-auto flex min-h-screen w-full min-w-0 max-w-[1440px] flex-col gap-6 overflow-x-hidden p-4 pb-28 md:p-6 md:pb-28 xl:flex-row xl:pb-6"
        style={{
          minHeight: "var(--app-viewport-stable-height, 100dvh)",
          paddingTop: "calc(1rem + var(--app-safe-area-top))",
          paddingRight: "calc(1rem + var(--app-safe-area-right))",
          paddingBottom: "calc(7rem + var(--app-safe-area-bottom))",
          paddingLeft: "calc(1rem + var(--app-safe-area-left))",
        }}
      >
        <div className="min-w-0 xl:hidden">{sidebar}</div>
        <aside
          className="hidden min-w-0 w-80 shrink-0 rounded-[28px] border p-4 shadow-[0_30px_80px_rgba(15,23,42,0.08)] backdrop-blur xl:block"
          style={{
            background: "color-mix(in srgb, var(--app-surface) 82%, transparent)",
            borderColor: "var(--app-border)",
          }}
        >
          {sidebar}
        </aside>
        <main
          className="min-w-0 w-full flex-1 rounded-[24px] border p-4 shadow-[0_30px_80px_rgba(15,23,42,0.1)] backdrop-blur md:rounded-[32px] md:p-6"
          style={{
            background: "color-mix(in srgb, var(--app-surface) 88%, transparent)",
            borderColor: "var(--app-border)",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  children,
  actions,
}: PropsWithChildren<{
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}>) {
  return (
    <section
      className="min-w-0 rounded-[24px] border p-5 shadow-sm"
      style={{
        background: "var(--app-surface)",
        borderColor: "var(--app-border)",
      }}
    >
      <div className="mb-4 flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            className="break-words font-['IBM_Plex_Sans',sans-serif] text-lg font-semibold tracking-tight text-slate-950"
            style={{ color: "var(--tg-section-header-text-color)" }}
          >
            {title}
          </h2>
          {subtitle ? (
            <p
              className="mt-1 break-words text-sm text-slate-500"
              style={{ color: "var(--app-muted-text)" }}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "success" | "warning" | "danger" }>) {
  const toneStyles = {
    neutral: {
      background: "var(--app-surface-soft)",
      color: "var(--app-muted-text)",
    },
    success: {
      background: "var(--app-success-bg)",
      color: "var(--app-success-text)",
    },
    warning: {
      background: "var(--app-warning-bg)",
      color: "var(--app-warning-text)",
    },
    danger: {
      background: "var(--app-danger-bg)",
      color: "var(--app-danger-text)",
    },
  } satisfies Record<string, { background: string; color: string }>;

  return (
    <span className="inline-flex rounded-full px-2.5 py-1 text-xs font-medium" style={toneStyles[tone]}>
      {children}
    </span>
  );
}

export function Button({
  children,
  tone = "primary",
  type = "button",
  className,
  ...props
}: PropsWithChildren<
  {
    tone?: "primary" | "secondary" | "ghost";
  } & ButtonHTMLAttributes<HTMLButtonElement>
>) {
  const toneClasses = {
    primary: "",
    secondary: "",
    ghost: "",
  } satisfies Record<string, string>;
  const toneStyles = {
    primary: {
      background: "var(--tg-button-color)",
      color: "var(--tg-button-text-color)",
    },
    secondary: {
      background: "var(--app-surface-soft)",
      color: "var(--tg-text-color)",
    },
    ghost: {
      background: "transparent",
      color: "var(--app-muted-text)",
    },
  } satisfies Record<string, { background: string; color: string }>;

  return (
    <button
      {...props}
      type={type}
      className={join(
        "inline-flex items-center rounded-full px-4 py-2 text-sm font-medium transition-colors",
        toneClasses[tone],
        className,
      )}
      style={{ ...toneStyles[tone], ...props.style }}
    >
      {children}
    </button>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      aria-label={props["aria-label"] ?? props.placeholder ?? undefined}
      className={join(
        "w-full rounded-2xl border px-4 py-3 text-sm outline-none transition",
        props.className,
      )}
      style={{
        borderColor: "var(--app-border)",
        background: "var(--app-surface-soft)",
        color: "var(--tg-text-color)",
        ...props.style,
      }}
    />
  );
}

export function TextArea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return (
    <textarea
      {...props}
      aria-label={props["aria-label"] ?? props.placeholder ?? undefined}
      className={join(
        "min-h-28 w-full rounded-2xl border px-4 py-3 text-sm outline-none transition",
        props.className,
      )}
      style={{
        borderColor: "var(--app-border)",
        background: "var(--app-surface-soft)",
        color: "var(--tg-text-color)",
        ...props.style,
      }}
    />
  );
}
