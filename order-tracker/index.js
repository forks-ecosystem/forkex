const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = 8084;
const DB = 'postgres://admin:root@localhost:5454/hollaex';
const EXPLORER_URL = 'http://127.0.0.1:8083';

const db = new Pool({ connectionString: DB });

app.get('/api/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const pair = req.query.pair || '';
    const side = req.query.side || '';

    let sql = `
      SELECT t.id, t.pair_id, t.symbol as pair, t.maker_id, t.taker_id,
             t.price, t.size as amount, (t.price * t.size) as total,
             t.side, t.maker_order_id, t.taker_order_id,
             t.created_at, t.timestamp
      FROM trades t
      WHERE 1=1
    `;
    const params = [];
    if (pair) {
      params.push(pair);
      sql += ` AND t.symbol = $${params.length}`;
    }
    if (side) {
      params.push(side);
      sql += ` AND t.side = $${params.length}`;
    }
    sql += ' ORDER BY t.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const { rows } = await db.query(sql, params);
    res.json({ trades: rows, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trades/summary', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT t.symbol as pair, count(*) as trades,
             sum(t.price * t.size) as volume,
             min(t.price) as low, max(t.price) as high,
             max(t.created_at) as last_trade
      FROM trades t
      GROUP BY t.symbol
      ORDER BY volume DESC
    `);
    res.json({ pairs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trades/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT t.*,
             mu.email as maker_email, tu.email as taker_email
      FROM trades t
      LEFT JOIN users mu ON t.maker_id = mu.id
      LEFT JOIN users tu ON t.taker_id = tu.id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'trade not found' });
    res.json({ trade: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LBTC Order Explorer</title>
  <style>
    :root{--gold:#D4A017;--bg:#080808;--panel:#141414;--border:#222;--text:#E8E8E8;--muted:#888;--green:#22C55E;--red:#EF4444;--mono:'Courier New',monospace}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:-apple-system,sans-serif;font-size:14px;line-height:1.6}
    a{color:var(--gold);text-decoration:none}
    nav{background:var(--panel);border-bottom:1px solid var(--border);padding:0 28px;display:flex;align-items:center;gap:28px;height:50px}
    .brand{font-size:16px;font-weight:700;color:var(--gold)}
    .brand small{font-size:11px;color:var(--muted);margin-left:5px}
    .navl{display:flex;gap:20px}
    .navl a{color:var(--muted);font-size:13px}
    .navl a:hover{color:var(--gold)}
    .c{max-width:1280px;margin:0 auto;padding:22px}
    h2{font-size:18px;margin-bottom:14px}
    h2 span{color:var(--gold)}
    .sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:22px}
    .sc{background:var(--panel);padding:14px}
    .sl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)}
    .sv{font-size:18px;font-weight:700;color:var(--gold);font-family:var(--mono)}
    .tw{overflow-x:auto;border:1px solid var(--border)}
    table{width:100%;border-collapse:collapse}
    th{background:var(--panel);color:var(--muted);font-size:10px;text-transform:uppercase;padding:8px 11px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
    td{padding:8px 11px;font-size:12px;border-bottom:1px solid var(--border);vertical-align:middle}
    tr:hover{background:rgba(255,255,255,.02)}
    .hash{font-family:var(--mono);font-size:11px}
    .buy{color:var(--green);font-weight:600}
    .sell{color:var(--red);font-weight:600}
    .p{display:flex;gap:8px;margin-top:14px}
    .p a,.p span{padding:5px 11px;background:var(--panel);border:1px solid var(--border);font-size:12px;color:var(--muted)}
    .p a:hover{border-color:var(--gold);color:var(--gold)}
    .p .cur{border-color:var(--gold);color:var(--gold)}
    .filt{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
    .filt select,.filt input{background:var(--panel);border:1px solid var(--border);color:var(--text);padding:5px 10px;font-size:12px}
    .filt button{background:var(--gold);color:var(--bg);border:none;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:700}
    footer{border-top:1px solid var(--border);padding:14px 28px;text-align:center;font-size:11px;color:var(--muted);margin-top:40px}
    footer span{color:var(--gold)}
  </style>
</head>
<body>
<nav>
  <a href="/" class="brand">📊 LBTC <small>ORDER TRACKER</small></a>
  <div class="navl">
    <a href="/">Trades</a>
    <a href="/pairs">Pairs</a>
    <a href="${EXPLORER_URL}" target="_blank">Block Explorer →</a>
  </div>
</nav>
<div class="c" id="app">
  <h2>Executed <span>Orders</span></h2>
  <div class="filt">
    <select id="pair">
      <option value="">All Pairs</option>
    </select>
    <select id="side">
      <option value="">All Sides</option>
      <option value="buy">Buy</option>
      <option value="sell">Sell</option>
    </select>
    <button onclick="load()">Filter</button>
  </div>
  <div id="summary" style="margin-bottom:14px"></div>
  <div class="tw"><table>
    <thead><tr>
      <th>ID</th><th>Pair</th><th>Side</th><th>Price</th><th>Amount</th><th>Total</th><th>Time (UTC)</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table></div>
  <div class="p" id="pages"></div>
</div>
<footer>LBTC <span>Order Explorer</span> · tracking exchange trades</footer>
<script>
let offset = 0, limit = 50;
function load() {
  const pair = document.getElementById('pair').value;
  const side = document.getElementById('side').value;
  let url = '/api/trades?limit=' + limit + '&offset=' + offset;
  if (pair) url += '&pair=' + pair;
  if (side) url += '&side=' + side;
  fetch(url).then(r => r.json()).then(d => {
    const tbody = document.getElementById('tbody');
    tbody.innerHTML = d.trades.map(t => '<tr>' +
      '<td class="hash">#' + t.id + '</td>' +
      '<td>' + t.pair + '</td>' +
      '<td class="' + t.side + '">' + t.side + '</td>' +
      '<td>' + parseFloat(t.price).toFixed(8) + '</td>' +
      '<td>' + parseFloat(t.amount).toFixed(8) + '</td>' +
      '<td>' + parseFloat(t.total).toFixed(8) + '</td>' +
      '<td>' + new Date(t.created_at).toISOString().slice(0,19).replace('T',' ') + '</td>' +
      '</tr>').join('');
    const pages = document.getElementById('pages');
    pages.innerHTML = (offset > 0 ? '<a href="#" onclick="page(-1)">← Prev</a>' : '') +
      '<span class="cur">' + (offset/limit + 1) + '</span>' +
      (d.trades.length >= limit ? '<a href="#" onclick="page(1)">Next →</a>' : '');
  });
}
function page(d) { offset = Math.max(0, offset + d * limit); load(); }
function loadPairs() {
  fetch('/api/trades/summary').then(r => r.json()).then(d => {
    const sel = document.getElementById('pair');
    const summary = document.getElementById('summary');
    summary.innerHTML = '<div class="sg">' + d.pairs.map(p =>
      '<div class="sc"><div class="sl">' + p.pair + '</div><div class="sv">' +
      parseFloat(p.trades).toLocaleString() + ' trades</div>' +
      '<div style="font-size:11px;color:var(--muted)">' +
      parseFloat(p.volume).toFixed(2) + ' vol</div></div>'
    ).join('') + '</div>';
    d.pairs.forEach(p => { const o = document.createElement('option'); o.value = p.pair; o.text = p.pair; sel.appendChild(o); });
  });
}
loadPairs();
load();
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Order Tracker on http://0.0.0.0:${PORT}`));
