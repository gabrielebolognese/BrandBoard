// Talking to the server without throwing.
//
// `await res.json()` throws when the body is not JSON, which is exactly what
// comes back from a proxy error page, a crashed process, or a dropped
// connection. Every caller here would have to wrap that in its own try, and one
// that forgot took the whole page down with an unhandled rejection. So the
// result is a value instead: callers check `ok` and always get a shape back.

/**
 * @returns {Promise<{ok: boolean, status: number, body: any, error: string|null}>}
 */
export async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    return { ok: false, status: 0, body: null, error: `Could not reach the server (${url}).` };
  }

  let body = null;
  const text = await response.text().catch(() => "");
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body from an endpoint that promises JSON is a server fault,
      // not something the caller can parse its way out of.
      return {
        ok: false,
        status: response.status,
        body: null,
        error: `The server returned something that was not JSON (${response.status}).`,
      };
    }
  }

  return { ok: response.ok, status: response.status, body, error: null };
}

export function getJson(url) {
  return request(url);
}

export function postJson(url, payload) {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

/**
 * Raw bytes, for the one thing that is not JSON going up.
 *
 * An upload posts the file itself rather than a form encoding, so there is no
 * filename and no declared type to be wrong about. The answer still comes back
 * through the same parser, so a failure here is a value like every other.
 */
export function postBinary(url, body, contentType) {
  return request(url, {
    method: "POST",
    headers: { "content-type": contentType || "application/octet-stream" },
    body,
  });
}

/** The message a server error carries, or a readable fallback. */
export function messageFrom(result, fallback) {
  return result.error ?? result.body?.message ?? fallback;
}
