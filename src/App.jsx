import { useEffect, useRef, useState } from 'react';
import { CURRENCIES, uid, toMinor, toMajor, fmt, computeShares, balances, settle, exportCSV, importCSV } from './logic';

const KEY = 'expense-splitter-v1';
const today = () => new Date().toISOString().slice(0, 10);
const newGroup = (name, currency) => ({ id: uid(), name, currency, people: [], expenses: [], payments: [] });
const load = () => {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s?.groups?.length) return s; } catch {}
  const g = newGroup('My group', 'USD');
  return { groups: [g], active: g.id };
};

export default function App() {
  const [s, setS] = useState(load);
  const [editing, setEditing] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [gName, setGName] = useState('');
  const [gCur, setGCur] = useState('USD');
  const fileRef = useRef();

  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }, [s]);
  const g = s.groups.find(x => x.id === s.active) || s.groups[0];
  const mut = fn => setS(p => { const n = structuredClone(p); fn(n, n.groups.find(x => x.id === p.active) || n.groups[0]); return n; });
  const name = id => g.people.find(p => p.id === id)?.name ?? '?';
  const cur = g.currency;

  const addGroup = e => {
    e.preventDefault();
    if (!gName.trim()) return;
    const ng = newGroup(gName.trim(), gCur);
    setS(p => ({ groups: [...p.groups, ng], active: ng.id })); setGName(''); setEditing(null);
  };
  const delGroup = () => {
    if (s.groups.length < 2) return alert('Keep at least one group.');
    if (!confirm(`Delete "${g.name}" and all its expenses?`)) return;
    setS(p => { const gs = p.groups.filter(x => x.id !== g.id); return { groups: gs, active: gs[0].id }; });
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exportCSV(s.groups)], { type: 'text/csv' }));
    a.download = `expense-splitter-${today()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const upload = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const imported = importCSV(await f.text());
      if (!imported.length) return alert('No data found in that CSV.');
      setS(p => ({ groups: [...p.groups, ...imported], active: imported[0].id }));
    } catch { alert('Could not read that CSV file.'); }
  };

  const net = balances(g);
  const suggestions = settle(net);
  const log = [...g.expenses.map(e => ({ ...e, kind: 'e' })), ...g.payments.map(p => ({ ...p, kind: 'p' }))].sort((a, b) => a.date.localeCompare(b.date));
  const pay = (from, to, amount) => mut((n, G) => G.payments.push({ id: uid(), date: today(), from, to, amount }));

  return (
    <div className="app">
      <header>
        <h1>Expense Splitter</h1>
        <div className="bar">
          <select value={g.id} onChange={e => { setS(p => ({ ...p, active: e.target.value })); setEditing(null); }} aria-label="Group">
            {s.groups.map(x => <option key={x.id} value={x.id}>{x.name} ({x.currency})</option>)}
          </select>
          <button onClick={delGroup}>Delete group</button>
          <button onClick={download}>Export CSV</button>
          <button onClick={() => fileRef.current.click()}>Import CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={upload} />
        </div>
        <form className="bar" onSubmit={addGroup}>
          <input value={gName} onChange={e => setGName(e.target.value)} placeholder="New group, e.g. Rome trip" />
          <select value={gCur} onChange={e => setGCur(e.target.value)} aria-label="Currency">{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select>
          <button className="primary">Create group</button>
        </form>
      </header>

      <main>
        <section>
          <h2>People</h2>
          <form className="bar" onSubmit={e => {
            e.preventDefault();
            const v = e.target.elements.pn.value.replace(/[|=]/g, '').trim();
            if (!v) return;
            if (g.people.some(p => p.name.toLowerCase() === v.toLowerCase())) return alert('That name is already in this group.');
            mut((n, G) => G.people.push({ id: uid(), name: v })); e.target.reset();
          }}>
            <input name="pn" placeholder="Add a person" /><button className="primary">Add</button>
          </form>
          <ul className="chips">
            {g.people.map(p => (
              <li key={p.id}>{p.name}
                <button aria-label={`Remove ${p.name}`} onClick={() => {
                  const used = g.expenses.some(e => e.payer === p.id || p.id in e.shares) || g.payments.some(x => x.from === p.id || x.to === p.id);
                  if (used) return alert(`${p.name} appears in expenses or payments. Delete those first.`);
                  mut((n, G) => { G.people = G.people.filter(x => x.id !== p.id); });
                }}>×</button>
              </li>
            ))}
          </ul>
          {!g.people.length && <p className="muted">Add the people sharing costs in this group.</p>}
        </section>

        <section>
          <h2>{editing ? 'Edit expense' : 'Add an expense'}</h2>
          <ExpenseForm key={editing?.id ?? 'new' + nonce} g={g} mut={mut} editing={editing}
            onDone={() => { setEditing(null); setNonce(n => n + 1); }} />
        </section>

        <section>
          <h2>Balances</h2>
          {g.people.map(p => (
            <div className="row" key={p.id}>
              <span>{p.name}</span>
              <b className={net[p.id] > 0 ? 'pos' : net[p.id] < 0 ? 'neg' : ''}>
                {net[p.id] > 0 ? `is owed ${fmt(net[p.id], cur)}` : net[p.id] < 0 ? `owes ${fmt(-net[p.id], cur)}` : 'settled'}
              </b>
            </div>
          ))}
          {!g.people.length && <p className="muted">No one here yet.</p>}
        </section>

        <section>
          <h2>Settle up</h2>
          {suggestions.map((x, i) => (
            <div className="row" key={i}>
              <span>{name(x.from)} pays {name(x.to)} <b>{fmt(x.amount, cur)}</b></span>
              <button onClick={() => pay(x.from, x.to, x.amount)}>Mark as settled</button>
            </div>
          ))}
          {!suggestions.length && <p className="muted">Everyone is even.</p>}
          <PaymentForm g={g} onPay={pay} />
        </section>

        <section className="wide">
          <h2>Expenses and payments</h2>
          {log.map(x => x.kind === 'e' ? (
            <div className="row" key={x.id}>
              <span><b>{x.desc}</b><small>{x.date}. {name(x.payer)} paid, split between {Object.keys(x.shares).map(name).join(', ')}</small></span>
              <span className="act"><b>{fmt(x.amount, cur)}</b>
                <button onClick={() => { setEditing(x); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</button>
                <button onClick={() => confirm(`Delete "${x.desc}"?`) && mut((n, G) => { G.expenses = G.expenses.filter(e => e.id !== x.id); })}>Delete</button>
              </span>
            </div>
          ) : (
            <div className="row" key={x.id}>
              <span><b>{name(x.from)} paid {name(x.to)}</b><small>{x.date}. Settlement</small></span>
              <span className="act"><b>{fmt(x.amount, cur)}</b>
                <button onClick={() => mut((n, G) => { G.payments = G.payments.filter(p => p.id !== x.id); })}>Delete</button>
              </span>
            </div>
          ))}
          {!log.length && <p className="muted">Nothing logged yet.</p>}
        </section>
      </main>
    </div>
  );
}

function PaymentForm({ g, onPay }) {
  const [f, setF] = useState({ from: '', to: '', amount: '' });
  const from = f.from || g.people[0]?.id, to = f.to || g.people[1]?.id;
  if (g.people.length < 2) return null;
  return (
    <form className="bar top" onSubmit={e => {
      e.preventDefault();
      const a = toMinor(f.amount, g.currency);
      if (a <= 0 || from === to) return alert('Pick two different people and a positive amount.');
      onPay(from, to, a); setF({ from: '', to: '', amount: '' });
    }}>
      <select value={from} onChange={e => setF({ ...f, from: e.target.value })}>{g.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <span>paid</span>
      <select value={to} onChange={e => setF({ ...f, to: e.target.value })}>{g.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <input inputMode="decimal" placeholder="Amount" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} />
      <button>Record payment</button>
    </form>
  );
}

function ExpenseForm({ g, mut, editing, onDone }) {
  const cur = g.currency;
  const [f, setF] = useState(() => editing
    ? { desc: editing.desc, amount: toMajor(editing.amount, cur), payer: editing.payer, date: editing.date, parts: Object.keys(editing.shares), mode: editing.mode, inputs: editing.inputs || {} }
    : { desc: '', amount: '', payer: null, date: today(), parts: null, mode: 'equal', inputs: {} });
  const [err, setErr] = useState('');
  const parts = (f.parts ?? g.people.map(p => p.id)).filter(id => g.people.some(p => p.id === id));
  const payer = f.payer ?? g.people[0]?.id;
  const set = o => setF(p => ({ ...p, ...o }));
  const total = toMinor(f.amount, cur);
  const entered = parts.reduce((a, id) => a + (f.mode === 'custom' ? toMinor(f.inputs[id] ?? 0, cur) : parseFloat(f.inputs[id]) || 0), 0);

  const submit = e => {
    e.preventDefault();
    if (!g.people.length) return setErr('Add people first.');
    if (!f.desc.trim()) return setErr('Add a description.');
    if (total <= 0) return setErr('Enter an amount greater than zero.');
    const r = computeShares(total, f.mode, parts, f.inputs, cur);
    if (r.error) return setErr(r.error);
    const ex = { id: editing?.id ?? uid(), date: f.date, desc: f.desc.trim(), amount: total, payer, mode: f.mode, inputs: f.mode === 'equal' ? {} : f.inputs, shares: r.shares };
    mut((n, G) => { if (editing) G.expenses = G.expenses.map(x => x.id === ex.id ? ex : x); else G.expenses.push(ex); });
    onDone();
  };

  return (
    <form className="form" onSubmit={submit}>
      <input placeholder="Description, e.g. Dinner" value={f.desc} onChange={e => set({ desc: e.target.value })} />
      <div className="bar">
        <input inputMode="decimal" placeholder={`Amount (${cur})`} value={f.amount} onChange={e => set({ amount: e.target.value })} />
        <input type="date" value={f.date} onChange={e => set({ date: e.target.value })} />
        <select value={payer ?? ''} onChange={e => set({ payer: e.target.value })} aria-label="Paid by">
          {g.people.map(p => <option key={p.id} value={p.id}>Paid by {p.name}</option>)}
        </select>
      </div>
      <div className="bar">
        {['equal', 'custom', 'percent'].map(m => (
          <label key={m}><input type="radio" checked={f.mode === m} onChange={() => set({ mode: m })} /> {{ equal: 'Equal', custom: 'Custom amounts', percent: 'Percentages' }[m]}</label>
        ))}
      </div>
      {g.people.map(p => {
        const on = parts.includes(p.id);
        return (
          <div className="row" key={p.id}>
            <label><input type="checkbox" checked={on} onChange={() => set({ parts: on ? parts.filter(x => x !== p.id) : [...parts, p.id] })} /> {p.name}</label>
            {on && f.mode !== 'equal' && (
              <input className="small" inputMode="decimal" placeholder={f.mode === 'percent' ? '%' : '0'} value={f.inputs[p.id] ?? ''}
                onChange={e => set({ inputs: { ...f.inputs, [p.id]: e.target.value } })} />
            )}
          </div>
        );
      })}
      {f.mode === 'custom' && <p className="muted">Entered {fmt(entered, cur)} of {fmt(total, cur)}</p>}
      {f.mode === 'percent' && <p className="muted">Entered {+entered.toFixed(2)}% of 100%</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="bar">
        <button className="primary">{editing ? 'Save changes' : 'Add expense'}</button>
        {editing && <button type="button" onClick={onDone}>Cancel</button>}
      </div>
    </form>
  );
}
