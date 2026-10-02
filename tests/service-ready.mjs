// Isolated test startup must finish before connecting the MCP client. Loaded
// machines can need more than the former five-second polling window.
export async function waitForService(origin, service, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let spawnError;
  const failed = error => { spawnError = error; };
  service.on('error', failed);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (service.exitCode !== null) throw new Error(`Isolated Canvy service exited before startup (${service.exitCode})`);
      const healthy = await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false);
      if (healthy) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Isolated Canvy service did not become healthy within ${timeout} ms`);
  } finally { service.off('error', failed); }
}
