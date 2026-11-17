// Loads a Tender Touch page in jsdom with the REAL supabase-js client.
// Only the network is faked: every request goes to a scripted backend that
// records it, so tests can assert exactly what the page sends to Supabase.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const supabaseLib = require('@supabase/supabase-js');

const ROOT = process.env.TT_ROOT || path.resolve(__dirname, '..', '..');
const SUPABASE_URL = 'https://test-project.supabase.co';

function parseRequest(url, init = {}) {
  const u = new URL(url);
  const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?([a-z_]+)/);
  return {
    method: (init.method || 'GET').toUpperCase(),
    table: m ? (m[1] ? 'rpc:' + m[2] : m[2]) : u.pathname,
    params: Object.fromEntries(u.searchParams),
    body: typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })()
      : init.body, // FormData / Blob for file uploads
    headers: init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {}),
  };
}

// Reply with rows the way PostgREST does: an object when the client asked for one row.
function rows(req, list) {
  const accept = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'accept')?.[1] || '';
  if (accept.includes('vnd.pgrst.object')) {
    return list.length === 1 ? { body: list[0] } : { status: 406, body: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
  }
  return { body: list };
}

// routes: array of [predicate(req) -> bool, responder(req) -> {status, body}]
function makeBackend(routes = []) {
  const calls = [];
  async function fetch(url, init) {
    const req = parseRequest(String(url), init);
    calls.push(req);
    for (const [match, respond] of routes) {
      if (match(req)) {
        const { status = 200, body = [], headers = {} } = respond(req) || {};
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
      }
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return { fetch, calls };
}

const when = (method, table, extra = () => true) => req => req.method === method && req.table === table && extra(req);

async function loadPage(page, { user, routes = [], scripts }) {
  const backend = makeBackend(routes);
  const inline = [];
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8')
    .replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/g, '') // external scripts loaded below
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (_, code) => { inline.push(code); return ''; });
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e));
  vc.on('error', () => {}); vc.on('warn', () => {}); vc.on('log', () => {});
  const dom = new JSDOM(html, {
    url: `http://localhost:8000/${page}`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.addEventListener('error', e => errors.push(e.error || e.message));
  w.addEventListener('unhandledrejection', e => errors.push(e.reason));
  w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  // Minimal Leaflet stand-in (maps are not under test).
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
  w.L = chain;
  w.fetch = backend.fetch; // weather/geocoding calls land in the backend log too
  w.supabase = {
    createClient: (url, key) => {
      const client = supabaseLib.createClient(SUPABASE_URL, key, {
        global: { fetch: backend.fetch }, auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: class { constructor() {} connect() {} close() {} } },
      });
      client.auth.getSession = async () => ({ data: { session: user ? { user, access_token: 't' } : null } });
      client.channel = () => ({ on() { return this; }, subscribe() { return this; } });
      return client;
    },
  };
  // Swallow unhandled rejections produced inside this window's microtasks.
  const onRejection = reason => errors.push(reason);
  process.on('unhandledRejection', onRejection);

  // Real <script> elements share one global lexical scope, like the browser.
  const inject = code => { const el = w.document.createElement('script'); el.textContent = code; w.document.body.appendChild(el); };
  for (const f of scripts) inject(fs.readFileSync(path.join(ROOT, f), 'utf8') + `\n//# sourceURL=${f}`);
  for (const code of inline) inject(code);
  // Answer in-page confirmation dialogs automatically unless a test opts out.
  if (typeof w.confirmDialog === 'function') {
    w.__realConfirmDialog = w.confirmDialog;
    w.confirmDialog = async () => w.__confirmAnswer ?? true;
  }

  const settle = async (ms = 30) => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, ms)); };
  await settle();
  const close = () => { process.off('unhandledRejection', onRejection); w.close(); };
  return { w, doc: w.document, backend, errors, settle, close };
}

module.exports = { loadPage, when, rows, ROOT };
