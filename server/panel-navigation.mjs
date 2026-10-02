import { randomUUID } from 'node:crypto';

// Navigation is delivered through the existing app-only exchange contract. It
// does not depend on the host opening another widget or on a new backend route.
export function createPanelNavigator(native) {
  const panels = new Map();
  const jobs = new Map();
  function live() { return [...panels.values()].filter(p => Date.now() - p.seen < 15000); }
  function rejectJob(job, error) { clearTimeout(job.timer); jobs.delete(job.id); job.reject(new Error(error)); }
  function observe(session, view = {}) {
    const previous = panels.get(session) ?? { panel_id: session, document_id: null, navigation: false, ready: false, active: false, last_interaction_at: 0 };
    const panel = { ...previous, ...view, panel_id: session, seen: Date.now() };
    panel.last_interaction_at = Math.min(Number(panel.last_interaction_at) || 0, Date.now());
    panels.set(session, panel); return panel;
  }
  async function bootstrap(args) {
    const result = await native('bootstrap', args);
    observe(result.session, { document_id: result.document?.id ?? null, navigation: ['0.3.4', '0.3.5', '0.3.6', '0.3.7', '0.4.0', '0.4.1', '0.5.0', '0.5.1', '0.5.2', '0.5.3', '0.5.4', '0.5.5', '0.5.6', '0.5.7', '0.5.8'].includes(args.ui_version), ui_version: args.ui_version });
    if (args.previous_session && panels.has(args.previous_session)) {
      for (const job of jobs.values()) if (job.panel_id === args.previous_session) job.panel_id = result.session;
      panels.delete(args.previous_session);
    }
    return result;
  }
  async function exchange(args) {
    const acknowledgements = (args.responses ?? []).filter(r => jobs.has(r.id) && jobs.get(r.id).panel_id === args.session);
    const responses = (args.responses ?? []).filter(r => !acknowledgements.includes(r));
    const result = await native('exchange', { session: args.session, responses });
    const panel = observe(args.session, args.view);
    const control = responses.find(r => r.id === '$freecanvas/control');
    if (control?.result?.operation === 'switch' && result.control) {
      panel.document_id = result.control.document?.id ?? null;
      panel.last_interaction_at = Date.now();
    }
    for (const acknowledgement of acknowledgements) {
      const job = jobs.get(acknowledgement.id);
      if (!job) continue; // A timeout can expire while the exchange is in flight.
      if (acknowledgement.error) rejectJob(job, acknowledgement.error);
      else if (acknowledgement.result?.document_id !== job.document_id) rejectJob(job, 'The panel did not acknowledge the requested canvas');
      else {
        clearTimeout(job.timer); jobs.delete(job.id);
        panel.document_id = job.document_id;
        job.resolve({ ...acknowledgement.result, panel_id: panel.panel_id, switched: true });
      }
    }
    // Regular edits already queued in the backend must finish before navigation.
    const job = [...jobs.values()].find(j => j.panel_id === args.session && !j.sent);
    if (job && !result.requests?.length && panel.ready && !panel.switching) {
      job.sent = true;
      result.requests = [{ id: job.id, command: 'freecanvas_navigate', args: { document_id: job.document_id } }];
    }
    return result;
  }
  function choose({ panel_id, from_document_id } = {}) {
    let candidates = live().filter(p => (!panel_id || p.panel_id === panel_id) && (from_document_id === undefined || p.document_id === from_document_id));
    if (!panel_id && candidates.some(p => p.navigation)) candidates = candidates.filter(p => p.navigation);
    if (!candidates.length) throw new Error('No connected panel matches this navigation target');
    let selected;
    if (candidates.length === 1) selected = candidates[0];
    else {
      const active = candidates.filter(p => p.active);
      if (active.length === 1) selected = active[0];
      else {
        const recent = [...candidates].sort((a, b) => b.last_interaction_at - a.last_interaction_at);
        if (recent[0].last_interaction_at > recent[1].last_interaction_at) selected = recent[0];
      }
    }
    if (!selected) throw new Error('Multiple panels are connected. Specify panel_id or from_document_id from list_open_canvases');
    if (!selected.navigation) throw new Error('This panel uses an older Canvy interface. Refresh it once to enable agent navigation');
    return selected;
  }
  async function navigate(args) {
    const panel = choose(args);
    if ([...jobs.values()].some(j => j.panel_id === panel.panel_id)) throw new Error('This panel is already switching canvases');
    const id = '$freecanvas/navigation/' + randomUUID();
    return new Promise((resolve, reject) => {
      const job = { id, panel_id: panel.panel_id, document_id: args.document_id ?? null, sent: false, resolve, reject };
      job.timer = setTimeout(() => rejectJob(job, 'Canvas navigation timed out. Check canvas_status before retrying'), 20000);
      jobs.set(id, job);
    });
  }
  async function disconnect(args) {
    const result = await native('disconnect', args);
    detach(args.session);
    return result;
  }
  function detach(session) {
    panels.delete(session);
    for (const job of [...jobs.values()]) if (job.panel_id === session) rejectJob(job, 'The panel closed before navigation completed');
  }
  return { bootstrap, exchange, disconnect, navigate, choose, list: live, observe, detach };
}
