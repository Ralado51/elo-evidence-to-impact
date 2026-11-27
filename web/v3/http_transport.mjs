// ARQ-04 / CMP-10 — single HTTP transport shared by the therapist and participant clients.
// Route allow-lists stay in each client (capabilities are NOT merged); this module only owns fetch, network/abort
// normalisation, JSON parsing and the error envelope mapping that used to be duplicated.
// Writes never pass `signal` (a persisted write is never cancelled by the UI).

/**
 * @param {{ fetchImpl: typeof fetch, url: string, method: string, headers: Record<string,string>, body?: unknown,
 *           signal?: AbortSignal, makeError: (info: {code:string,status:number,message:string,details?:unknown}) => Error }} p
 */
export async function performRequest({ fetchImpl, url, method, headers, body, signal, makeError }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err && (err.name === "AbortError" || signal?.aborted)) {
      throw makeError({ code: "ABORTED", status: 0, message: "Request aborted." });
    }
    throw makeError({ code: "NETWORK_ERROR", status: 0, message: err instanceof Error ? err.message : "Network request failed." });
  }

  let data = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errObj = data && typeof data === "object" && data.error ? data.error : null;
    const code =
      (errObj && typeof errObj.code === "string" && errObj.code) ||
      (response.status === 401 ? "UNAUTHENTICATED" : response.status === 403 ? "FORBIDDEN" : response.status === 404 ? "NOT_FOUND" : "HTTP_ERROR");
    const message = (errObj && typeof errObj.message === "string" && errObj.message) || `HTTP ${response.status}`;
    throw makeError({ code, status: response.status, message, details: errObj?.details ?? null });
  }
  return { status: response.status, headers: response.headers, data };
}
