// Hax Studio For Discord Bots - backend (HSS# + discord.js)
const http = require('http'), fs = require('fs'), crypto = require('crypto'), vm = require('vm');
const { Client, GatewayIntentBits } = require('discord.js');
const DB = process.env.DB_FILE || './data.json';
let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB)); } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const live = {};

// ---------- HSS# -> JS ----------
const BAD = /\b(constructor|prototype|__proto__|process|require|global|globalThis|this|eval|Function|import|while|for|async|await|setTimeout|setInterval)\b|[\[\]`]/;
function tr(src) {
  let js = src.split(/("(?:[^"\\\n]|\\.)*")/).map((p, i) => i % 2 ? p : p
    .replace(/\.\./g, '+').replace(/~=/g, '!=')
    .replace(/\belseif\b(.*?)\bthen\b/g, '} else if ($1) {')
    .replace(/\bif\b(.*?)\bthen\b/g, 'if ($1) {')
    .replace(/\belse\b/g, '} else {').replace(/\bend\b/g, '}')
    .replace(/\bnil\b/g, 'null').replace(/\band\b/g, '&&').replace(/\bor\b/g, '||')
    .replace(/\bnot\b/g, '!').replace(/\blocal\b/g, '')).join('');
  // remove cond( ... ) mantendo o conteudo
  let out = '', st = [], q = false;
  for (let i = 0; i < js.length; i++) {
    const c = js[i];
    if (c === '"') { q = !q; out += c; continue; }
    if (q) { if (c === '\\') out += c + js[++i]; else out += c; continue; }
    if (js.startsWith('cond(', i) && !/\w/.test(js[i - 1] || ' ')) { st.push(true); i += 4; continue; }
    if (c === '(') st.push(false);
    if (c === ')') { if (st.pop()) continue; }
    out += c;
  }
  return out;
}
function run(code, ctx) {
  const out = [];
  try {
    if (BAD.test(code)) throw new Error('Blocked syntax');
    const uv = (ctx.vars[ctx.uid] = ctx.vars[ctx.uid] || {});
    const env = {
      username: ctx.username,
      userVar: { Add: (n, v) => { uv[n] = v; }, Get: n => (uv[n] === undefined ? null : uv[n]) },
      bot: { Reply: (...a) => { out.push(a.join('')); } },
      randomNumber: (a, b) => Math.floor(Math.random() * (b - a + 1)) + Number(a),
      randomText: (...a) => a[Math.floor(Math.random() * a.length)],
    };
    // identificadores desconhecidos viram texto (ex.: userVar.Get(Coins))
    const p = new Proxy(env, {
      has: () => true,
      get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : String(k)),
      set: (t, k, v) => ((t[k] = v), true),
    });
    vm.runInNewContext('with(p){' + tr(code) + '\n}', { p }, { timeout: 300 });
  } catch (e) { out.push('Error: ' + e.message); }
  return out;
}

// ---------- bots ----------
async function stop(id) { const c = live[id]; delete live[id]; if (c) await c.destroy(); }
async function start(b) {
  await stop(b.id);
  if (!b.token) throw new Error('Defina o token do bot primeiro');
  const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  c.on('messageCreate', async m => {
    if (m.author.bot || !m.content.startsWith(b.prefix)) return;
    const n = m.content.slice(b.prefix.length).trim().split(/\s+/)[0].toLowerCase();
    const cmd = b.cmds.find(x => x.name.toLowerCase() === n);
    if (!cmd) return;
    const o = run(cmd.code, { uid: m.author.id, username: m.author.username, vars: b.vars });
    save();
    for (const t of o) if (t) await m.reply(t.slice(0, 2000)).catch(() => {});
  });
  await c.login(b.token);
  live[b.id] = c; b.on = true; save();
}
const allBots = () => Object.values(db.users).flatMap(u => u.bots);
allBots().filter(b => b.on).forEach(b => start(b).catch(() => { b.on = false; }));

// ---------- HTTP ----------
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const send = (r, c, o) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
const pub = b => ({ id: b.id, name: b.name, prefix: b.prefix, cmds: b.cmds, on: !!live[b.id], hasToken: !!b.token });
http.createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/api')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(__dirname + '/index.html')); }
    let body = ''; for await (const ch of req) body += ch;
    const d = body ? JSON.parse(body) : {}, path = req.url.slice(4), M = req.method;
    if (M === 'POST' && (path === '/register' || path === '/login')) {
      const n = String(d.name || '').trim().toLowerCase(), pw = String(d.pass || '');
      if (!/^[a-z0-9_]{3,20}$/.test(n) || pw.length < 6) return send(res, 400, { error: 'Nome: 3-20 letras/numeros/_ ; senha: minimo 6' });
      let u = db.users[n];
      if (path === '/register') {
        if (u) return send(res, 400, { error: 'Nome ja existe' });
        const salt = crypto.randomBytes(16).toString('hex');
        u = db.users[n] = { salt, hash: hash(pw, salt), bots: [] };
      } else if (!u || hash(pw, u.salt) !== u.hash) return send(res, 400, { error: 'Nome ou senha incorretos' });
      const tk = crypto.randomBytes(24).toString('hex'); db.sessions[tk] = n; save();
      return send(res, 200, { tk });
    }
    const u = db.users[db.sessions[req.headers['x-auth']]];
    if (!u) return send(res, 401, { error: 'Sessao expirada' });
    const m = path.match(/^\/bots(?:\/(\w+))?(?:\/(start|stop))?$/);
    if (!m) return send(res, 404, { error: 'Nao encontrado' });
    const b = u.bots.find(x => x.id === m[1]);
    if (!m[1]) {
      if (M === 'GET') return send(res, 200, u.bots.map(pub));
      const nb = { id: crypto.randomBytes(6).toString('hex'), name: String(d.name || 'Meu bot').slice(0, 30), token: '', prefix: '!', on: false, vars: {},
        cmds: [{ name: 'ping', code: 'bot.Reply("Pong, " .. username .. "!")' }] };
      u.bots.push(nb); save(); return send(res, 200, pub(nb));
    }
    if (!b) return send(res, 404, { error: 'Bot nao encontrado' });
    if (m[2] === 'start') { await start(b).catch(e => { b.on = false; throw e; }); return send(res, 200, pub(b)); }
    if (m[2] === 'stop') { await stop(b.id); b.on = false; save(); return send(res, 200, pub(b)); }
    if (M === 'DELETE') { await stop(b.id); u.bots = u.bots.filter(x => x !== b); save(); return send(res, 200, {}); }
    if (M === 'PUT') {
      if (d.name) b.name = String(d.name).slice(0, 30);
      if (d.prefix) b.prefix = String(d.prefix).slice(0, 3);
      if (d.token) b.token = String(d.token).trim();
      if (Array.isArray(d.cmds)) b.cmds = d.cmds.slice(0, 50).map(c => ({ name: String(c.name).slice(0, 30), code: String(c.code).slice(0, 20000) }));
      save(); return send(res, 200, pub(b));
    }
    send(res, 405, { error: 'Metodo invalido' });
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(process.env.PORT || 3000, () => console.log('Hax Studio online'));
