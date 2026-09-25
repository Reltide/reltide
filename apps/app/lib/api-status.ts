import { getHealth } from "@repo/api-client";

export interface ApiStatus {
  kind: "unconfigured" | "available" | "unavailable";
}

export const getApiStatus = async (baseUrl?: string): Promise<ApiStatus> => {
  if (!baseUrl) {
    return { kind: "unconfigured" };
  }

  try {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { kind: "unavailable" };
    }

    const result = await getHealth({
      baseUrl,
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return result.response?.ok && result.data?.status === "ok"
      ? { kind: "available" }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
};
