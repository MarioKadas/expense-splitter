export const CURRENCIES = ['USD','EUR','GBP','JPY','CNY','CHF','CAD','AUD','NZD','HKD','SGD','INR','KRW','BRL','MXN','SEK','NOK','DKK','PLN','CZK','TRY','ZAR','AED','SAR','THB'];
export const uid = () => Math.random().toString(36).slice(2, 10);

// Amounts are stored as integers in the currency's minor unit (cents, yen, ...).
const dec = c => new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits;
export const toMinor = (s, c) => { const n = parseFloat(String(s).replace(',', '.')); return isNaN(n) ? 0 : Math.round(n * 10 ** dec(c)); };
export const toMajor = (m, c) => (m / 10 ** dec(c)).toFixed(dec(c));
export const fmt = (m, c) => new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(m / 10 ** dec(c));

export function computeShares(total, mode, ids, inputs, cur) {
  if (!ids.length) return { error: 'Pick at least one person to split between.' };
  if (mode === 'equal') {
    const base = Math.floor(total / ids.length);
    let r = total - base * ids.length;
    return { shares: Object.fromEntries(ids.map(id => [id, base + (r-- > 0 ? 1 : 0)])) };
  }
  if (mode === 'custom') {
    const shares = Object.fromEntries(ids.map(id => [id, toMinor(inputs[id] ?? 0, cur)]));
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    if (sum !== total) return { error: `Amounts add up to ${fmt(sum, cur)}, but the total is ${fmt(total, cur)}.` };
    return { shares };
  }
  const pct = ids.map(id => parseFloat(inputs[id]) || 0);
  const psum = pct.reduce((a, b) => a + b, 0);
  if (Math.abs(psum - 100) > 0.001) return { error: `Percentages add up to ${+psum.toFixed(3)}%, they must add up to 100%.` };
  const raw = pct.map(p => (total * p) / 100), fl = raw.map(Math.floor);
  let left = total - fl.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) fl[i]++; });
  return { shares: Object.fromEntries(ids.map((id, i) => [id, fl[i]])) };
}

// net > 0: is owed money; net < 0: owes money
export function balances(g) {
  const n = Object.fromEntries(g.people.map(p => [p.id, 0]));
  for (const e of g.expenses) { n[e.payer] += e.amount; for (const [id, s] of Object.entries(e.shares)) n[id] -= s; }
  for (const p of g.payments) { n[p.from] += p.amount; n[p.to] -= p.amount; }
  return n;
}

// Minimum payments: split people into the maximum number of independent zero-sum
// groups (exact bitmask DP, up to 16 people), then settle each group greedily.
// A group of k people needs k-1 payments, so more groups = fewer payments.
export function settle(net) {
  const items = Object.entries(net).filter(([, v]) => v !== 0);
  const m = items.length;
  let groups;
  if (m <= 16) {
    const N = 1 << m, sum = new Array(N).fill(0), dp = new Array(N).fill(0), prev = new Array(N).fill(0);
    for (let k = 1; k < N; k++) {
      const low = k & -k;
      sum[k] = sum[k ^ low] + items[31 - Math.clz32(low)][1];
      let best = -1;
      for (let i = 0; i < m; i++) if (k >> i & 1) { const v = dp[k ^ (1 << i)]; if (v > best) { best = v; prev[k] = i; } }
      dp[k] = best + (sum[k] === 0 ? 1 : 0);
    }
    const order = [];
    for (let k = N - 1; k; k ^= 1 << prev[k]) order.push(prev[k]);
    order.reverse();
    groups = []; let cur = [], s = 0;
    for (const i of order) { cur.push(items[i]); s += items[i][1]; if (s === 0) { groups.push(cur); cur = []; } }
  } else groups = [items];
  const out = [];
  for (const grp of groups) {
    const d = grp.filter(x => x[1] < 0).map(x => [...x]).sort((a, b) => a[1] - b[1]);
    const c = grp.filter(x => x[1] > 0).map(x => [...x]).sort((a, b) => b[1] - a[1]);
    let i = 0, j = 0;
    while (i < d.length && j < c.length) {
      const a = Math.min(-d[i][1], c[j][1]);
      out.push({ from: d[i][0], to: c[j][0], amount: a });
      d[i][1] += a; c[j][1] -= a;
      if (d[i][1] === 0) i++;
      if (c[j][1] === 0) j++;
    }
  }
  return out;
}

/* ---------- CSV ---------- */
const esc = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };

export function exportCSV(groups) {
  const rows = [['type', 'group', 'currency', 'date', 'description', 'amount', 'payer', 'mode', 'split', 'to']];
  for (const g of groups) {
    const nm = id => g.people.find(p => p.id === id)?.name ?? '?';
    const base = t => [t, g.name, g.currency];
    g.people.forEach(p => rows.push([...base('person'), '', p.name]));
    g.expenses.forEach(e => rows.push([...base('expense'), e.date, e.desc, toMajor(e.amount, g.currency), nm(e.payer), e.mode === 'equal' ? 'equal' : 'custom',
      Object.entries(e.shares).map(([id, a]) => `${nm(id)}=${toMajor(a, g.currency)}`).join('|')]));
    g.payments.forEach(p => rows.push([...base('payment'), p.date, '', toMajor(p.amount, g.currency), nm(p.from), '', '', nm(p.to)]));
  }
  return rows.map(r => r.map(esc).join(',')).join('\n');
}

function parseCSV(t) {
  const rows = []; let r = [], c = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { r.push(c); c = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; r.push(c); c = ''; rows.push(r); r = []; }
    else c += ch;
  }
  if (c || r.length) { r.push(c); rows.push(r); }
  return rows;
}

export function importCSV(text) {
  const rows = parseCSV(text).slice(1).filter(r => r.length > 1);
  const gs = new Map();
  const grp = (n, c) => { if (!gs.has(n)) gs.set(n, { id: uid(), name: n, currency: c || 'USD', people: [], expenses: [], payments: [] }); return gs.get(n); };
  const pid = (g, n) => { let p = g.people.find(x => x.name === n); if (!p) { p = { id: uid(), name: n }; g.people.push(p); } return p.id; };
  for (const [type, gn, cur, date, desc, amt, payer, mode, split, to] of rows) {
    const g = grp(gn, cur);
    if (type === 'person') pid(g, desc);
    else if (type === 'expense') {
      const shares = {}, inputs = {};
      for (const part of (split || '').split('|')) {
        const [n, a] = part.split('=');
        if (!n) continue;
        const id = pid(g, n); shares[id] = toMinor(a, g.currency); inputs[id] = a;
      }
      g.expenses.push({ id: uid(), date, desc, amount: toMinor(amt, g.currency), payer: pid(g, payer), mode: mode === 'equal' ? 'equal' : 'custom', inputs: mode === 'equal' ? {} : inputs, shares });
    } else if (type === 'payment') g.payments.push({ id: uid(), date, from: pid(g, payer), to: pid(g, to), amount: toMinor(amt, g.currency) });
  }
  return [...gs.values()];
}
