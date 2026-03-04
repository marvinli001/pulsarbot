export async function apiFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    credentials: "include",
    headers,
    ...init,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
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
