// Aqua Ding backend: Web Push reminders via one Durable Object per device.
// A device id (random, stored on the phone) maps to a Reminder object that keeps the
// push subscription, the settings and an exact alarm for the next reminder.

const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const SUBJECT = 'https://aquading.majood-saod.workers.dev';
const NAG_MS = 5 * 60 * 1000;

const enc = new TextEncoder();
export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64uStr = (str) => b64u(enc.encode(str));

export function allowedEndpoint(ep) {
  try {
    const u = new URL(ep);
    if (u.protocol !== 'https:') return false;
    return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) { return false; }
}

export function hourIn(t, tz) {
  try {
    const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t), 10);
    return h === 24 ? 0 : h;
  } catch (e) { return new Date(t).getUTCHours(); }
}
export function inWindow(t, c) { const h = hourIn(t, c.tz); return h >= c.from && h < c.to; }
export function bump(t, c) {
  let n = 0;
  while (!inWindow(t, c) && n++ < 400) t += 5 * 60 * 1000;
  return t;
}

export function cleanSettings(s, old) {
  s = s || {};
  const o = old || { every: 45, from: 8, to: 22, tz: 'UTC' };
  const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  let tz = typeof s.tz === 'string' && s.tz.length <= 64 ? s.tz : o.tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { tz = o.tz; }
  const from = int(s.from, 0, 23, o.from);
  let to = int(s.to, 1, 24, o.to);
  if (to <= from) to = 24;
  return { every: int(s.every, 1, 240, o.every), from, to, tz };
}

export async function vapidHeader(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const header = b64uStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64uStr(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload)));
  return 'vapid t=' + header + '.' + payload + '.' + b64u(sig) + ', k=' + keys.pub;
}

// Holds the VAPID key pair. Generated once on first use, never leaves the Worker except the public half.
export class Vapid {
  constructor(ctx) { this.ctx = ctx; }
  async fetch() {
    let k = await this.ctx.storage.get('keys');
    if (!k) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      k = { priv, pub: b64u(pub) };
      await this.ctx.storage.put('keys', k);
    }
    return Response.json(k);
  }
}

export class Reminder {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.keysCache = null; }

  async keys() {
    if (!this.keysCache) {
      const stub = this.env.VAPID.get(this.env.VAPID.idFromName('v1'));
      this.keysCache = await (await stub.fetch('https://vapid/keys')).json();
    }
    return this.keysCache;
  }

  scheduleMain(st, now) {
    st.mainAt = bump(now + st.every * 60000, st);
    st.nextAt = st.mainAt;
    st.kind = 'main';
  }

  async fetch(req) {
    const b = await req.json();
    const now = Date.now();
    const st = (await this.ctx.storage.get('st')) || {};
    const cfg = cleanSettings(b.settings, st.every ? st : null);

    switch (b.action) {
      case 'subscribe':
        if (!b.sub || !allowedEndpoint(b.sub.endpoint)) return Response.json({ error: 'bad subscription' }, { status: 400 });
        Object.assign(st, cfg);
        st.sub = { endpoint: b.sub.endpoint };
        st.active = true;
        this.scheduleMain(st, now);
        break;
      case 'settings':
        Object.assign(st, cfg);
        if (st.active) this.scheduleMain(st, now);
        break;
      case 'logged':
        if (st.active) this.scheduleMain(st, now);
        break;
      case 'snooze': {
        const m = Number.isInteger(b.minutes) && b.minutes >= 1 && b.minutes <= 60 ? b.minutes : 5;
        if (st.active) { st.kind = 'snooze'; st.nextAt = bump(now + m * 60000, st); }
        break;
      }
      case 'stop':
        st.active = false;
        delete st.nextAt;
        await this.ctx.storage.deleteAlarm();
        break;
      case 'status':
        break;
      default:
        return Response.json({ error: 'unknown action' }, { status: 400 });
    }

    await this.ctx.storage.put('st', st);
    if (st.active) await this.ctx.storage.setAlarm(st.nextAt);
    return Response.json({ active: !!st.active, nextAt: st.active ? st.nextAt : null, now });
  }

  async push(sub) {
    const keys = await this.keys();
    const auth = await vapidHeader(sub.endpoint, keys);
    const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: auth, TTL: '1800', Urgency: 'high' } });
    return r.status;
  }

  async alarm() {
    const st = await this.ctx.storage.get('st');
    if (!st || !st.active || !st.sub) return;
    const now = Date.now();

    let status = 0;
    try { status = await this.push(st.sub); } catch (e) { status = 0; }
    if (status === 404 || status === 410) {
      st.active = false; delete st.sub; delete st.nextAt;
      await this.ctx.storage.put('st', st);
      return;
    }

    // After a main reminder or a snooze, nag twice (5 min apart) in case it was missed.
    // A water log cancels the nags by rescheduling. Very short test intervals skip nagging.
    const nags = st.every >= 15;
    if ((st.kind === 'main' || st.kind === 'snooze' || !st.kind)) {
      st.mainAt = now;
      if (nags && inWindow(now + NAG_MS, st)) { st.kind = 'nag1'; st.nextAt = now + NAG_MS; }
      else this.scheduleMain(st, now);
    } else if (st.kind === 'nag1') {
      if (inWindow(now + NAG_MS, st)) { st.kind = 'nag2'; st.nextAt = now + NAG_MS; }
      else this.scheduleMain(st, st.mainAt);
    } else {
      this.scheduleMain(st, st.mainAt || now);
      if (st.nextAt <= now) this.scheduleMain(st, now);
    }
    await this.ctx.storage.put('st', st);
    await this.ctx.storage.setAlarm(st.nextAt);
  }
}

const json = (o, status = 200) => Response.json(o, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/vapid' && req.method === 'GET') {
      const k = await (await env.VAPID.get(env.VAPID.idFromName('v1')).fetch('https://vapid/keys')).json();
      return json({ key: k.pub });
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const text = await req.text();
      if (text.length > 4096) return json({ error: 'too large' }, 413);
      let b;
      try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!b || typeof b.id !== 'string' || !/^[a-f0-9]{32}$/.test(b.id)) return json({ error: 'bad id' }, 400);
      const stub = env.REMINDER.get(env.REMINDER.idFromName(b.id));
      const r = await stub.fetch('https://reminder/do', { method: 'POST', body: JSON.stringify(b) });
      return json(await r.json(), r.status);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(req);
  },
};
