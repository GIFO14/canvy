// A backend restart rotates its private bridge token. Retry only an explicit
// authentication rejection, which happens before the server executes the request.
export function createServiceClient(origin, { ensureService } = {}) {
  let token;
  return async function request(path, body) {
    // Check liveness before sending a mutation. Never replay an uncertain write
    // merely because its connection failed after the request was sent.
    await ensureService?.();
    async function refreshToken() {
      const response = await fetch(`${origin}/api/bootstrap`);
      if (!response.ok) throw new Error('Canvy service is unavailable');
      token = (await response.json()).token;
    }
    async function send() {
      return fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(35000)
      });
    }
    if (!token) await refreshToken();
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      await refreshToken();
      response = await send();
    }
    return response;
  };
}
