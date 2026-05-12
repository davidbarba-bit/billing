/**
 * Loads the official lago-javascript-client lazily. If the SDK is not
 * installable in the test environment (e.g. offline CI), tests that depend on
 * it skip themselves cleanly instead of erroring out at import time.
 */
export type LagoSdkBundle = {
  available: boolean;
  // The exact SDK surface varies between versions; we type-erase it here and
  // assert per-test. This keeps the harness compatible with multiple v1.x lines.
  client?: unknown;
  errorReason?: string;
};

export async function loadLagoSdk(
  baseUrl: string,
  apiKey: string,
): Promise<LagoSdkBundle> {
  try {
    const mod = (await import("lago-javascript-client")) as unknown as {
      Client?: (apiKey: string, apiConfig?: { baseUrl?: string }) => unknown;
      getLagoApiClient?: (apiKey: string, opts?: { baseUrl?: string }) => unknown;
    };
    // The published Client is a factory function, not a constructor.
    if (typeof mod.Client === "function") {
      const client = mod.Client(apiKey, { baseUrl: `${baseUrl}/api/v1` });
      return { available: true, client };
    }
    if (typeof mod.getLagoApiClient === "function") {
      return {
        available: true,
        client: mod.getLagoApiClient(apiKey, { baseUrl: `${baseUrl}/api/v1` }),
      };
    }
    return { available: false, errorReason: "no Client export found" };
  } catch (err) {
    return {
      available: false,
      errorReason: err instanceof Error ? err.message : "unknown",
    };
  }
}
