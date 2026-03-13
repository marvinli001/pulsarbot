let refreshSessionPromise: Promise<void> | null = null;

async function refreshTelegramSession(): Promise<void> {
  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  refreshSessionPromise = (async () => {
    const response = await fetch("/api/session/telegram", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(devTelegramSessionPayload()),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    await response.json().catch(() => null);
  })();

  try {
    await refreshSessionPromise;
  } finally {
    refreshSessionPromise = null;
  }
}

async function apiRequest(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const doFetch = () => fetch(input, {
    credentials: "include",
    headers,
    ...init,
  });
  let response = await doFetch();

  if (response.status === 401 && input !== "/api/session/telegram") {
    await refreshTelegramSession();
    response = await doFetch();
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response;
}

export async function apiFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await apiRequest(input, init);
  return response.json() as Promise<T>;
}

export async function apiFetchText(
  input: string,
  init?: RequestInit,
): Promise<string> {
  const response = await apiRequest(input, init);
  return response.text();
}

export function devTelegramSessionPayload() {
  const telegram = (window as Window & {
    Telegram?: {
      WebApp?: {
        initData?: string;
        initDataUnsafe?: {
          user?: {
            id?: number | string;
            username?: string;
          };
        };
      };
    };
  }).Telegram;

  if (telegram?.WebApp?.initData) {
    return { initData: telegram.WebApp.initData };
  }

  if (telegram?.WebApp?.initDataUnsafe?.user?.id) {
    return {
      userId: String(telegram.WebApp.initDataUnsafe.user.id),
      username: telegram.WebApp.initDataUnsafe.user.username,
    };
  }

  return { userId: "dev-owner", username: "dev" };
}
