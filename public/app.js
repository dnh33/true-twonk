// True Twonk: one Twonk in, its true rank and the collection's top 3 out.
// Every figure comes from public/data, built from Twetch's API at build time (tools/build-data.mjs).
// The only live requests are the Twonk images, straight from Twetch's media route, and the on-chain check a visitor
// opens (Twetch's API for the current output, WhatsOnChain for the transaction).
import { chainRecord, traitsOf } from '/chain.js';

const MEDIA = 'https://api.twetch.com/v1/media/';
const TIERS = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Exotic'];
const $ = (s) => document.querySelector(s);
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let index = null;
let misprints = null;
const fleets = new Map();

// ---------- sound: synthesised, no audio files ----------
let audio = null;
let soundOn = true;
try { soundOn = localStorage.getItem('tt-sound') !== 'off'; } catch {}
function ctx() { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); return audio; }
function tone(freq, at, dur, type = 'sine', gain = 0.12) {
  // a shared link opens straight on an answer: stay quiet until the visitor has touched the page
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  const a = ctx(), o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, a.currentTime + at);
  g.gain.setValueAtTime(0.0001, a.currentTime + at);
  g.gain.exponentialRampToValueAtTime(gain, a.currentTime + at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + dur);
  o.connect(g).connect(a.destination); o.start(a.currentTime + at); o.stop(a.currentTime + at + dur + 0.05);
}
const sfx = {
  // the lock-in: a low hit, then the tension pad
  lock() { if (!soundOn) return; tone(55, 0, 0.5, 'sawtooth', 0.09); tone(110, 0, 0.35, 'square', 0.04); tone(220, 0.08, 0.9, 'triangle', 0.05); tone(233, 0.08, 0.9, 'triangle', 0.04); },
  // the answer: up a bright arpeggio when Twetch undersold it, a flat pair when it did not
  win() { if (!soundOn) return; [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.05 + i * 0.09, 0.5, 'triangle', 0.08)); tone(1568, 0.45, 0.8, 'sine', 0.05); },
  same() { if (!soundOn) return; tone(392, 0.05, 0.35, 'triangle', 0.07); tone(392, 0.28, 0.5, 'triangle', 0.07); },
  down() { if (!soundOn) return; tone(330, 0.05, 0.4, 'triangle', 0.07); tone(247, 0.3, 0.7, 'triangle', 0.07); },
  miss() { if (!soundOn) return; tone(150, 0, 0.25, 'square', 0.05); tone(110, 0.12, 0.35, 'square', 0.05); },
};
function paintSound() {
  const b = $('#sound'); b.setAttribute('aria-pressed', String(soundOn)); b.setAttribute('aria-label', soundOn ? 'Sound on' : 'Sound off');
}
$('#sound').addEventListener('click', () => { soundOn = !soundOn; try { localStorage.setItem('tt-sound', soundOn ? 'on' : 'off'); } catch {} paintSound(); if (soundOn) tone(660, 0, 0.15, 'triangle', 0.06); });
paintSound();

// ---------- data ----------
async function loadIndex() {
  const r = await fetch('/data/index.json');
  if (!r.ok) throw new Error('index');
  index = await r.json();
  // small, and needed to mark a misprint on the first answer; a failed read only hides the misprint tier
  misprints = await fetch('/data/misprints.json').then((m) => (m.ok ? m.json() : null)).catch(() => null);
  $('#fleets').innerHTML = index.fleets.map((f) => `<option value="${esc(f.name)} "></option>`).join('');
  const d = new Date(index.at);
  $('#dataline').textContent = `Counts from Twetch's API, read ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${d.getFullYear()}.`;
}
async function loadFleet(c) {
  if (!fleets.has(c)) fleets.set(c, fetch(`/data/${c}.json`).then((r) => { if (!r.ok) throw new Error('fleet'); return r.json(); }));
  return fleets.get(c);
}

// ---------- reading what people type ----------
/** A Twetch link (any URL holding the collection's 64-character address), or "collection number". */
function parse(text) {
  const s = text.trim();
  const hex = s.match(/[a-f0-9]{64}/i);
  if (hex) {
    const fleet = index.fleets.find((f) => f.c === hex[0].toLowerCase());
    if (!fleet) return { error: 'That link points to a collection this site does not cover.' };
    const after = s.slice(hex.index + 64);
    const num = (after.match(/token=(\d+)/) || after.match(/[/#](\d+)\b/) || [])[1];
    return num ? { fleet, number: +num } : { error: `Found ${fleet.name}, but not a Twonk number in that link. Add it, like "${fleet.name} 12".` };
  }
  const m = s.match(/^(.*?)[\s#/-]*(\d+)\s*$/);
  const name = norm(m ? m[1] : s);
  if (!name) return { error: 'Type a collection and a number, like "Frog Cartel 514".' };
  const by = (test) => index.fleets.filter(test).sort((a, b) => b.n - a.n)[0];
  const fleet = by((f) => norm(f.name) === name) || by((f) => norm(f.name).startsWith(name)) || by((f) => norm(f.name).includes(name)) || by((f) => f.slug.split('-').some((w) => w.startsWith(name)));
  if (!fleet) return { error: `No collection called "${m ? m[1].trim() : s}". Pick one from the list as you type.` };
  if (!m) return { error: `Which ${fleet.name}? Add its number, like "${fleet.name} 12".` };
  return { fleet, number: +m[2] };
}

// ---------- the answer ----------
const tierName = (i) => (i >= 0 ? TIERS[i] : null);
// counts and doses keep changing (burns, vaccinations), so a rank is only true as of the day the data was read
const asOf = () => { const d = new Date(index.at); return `as of ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`; };
// a checked-on date (YYYY-MM-DD) written like the rest of the page: 29 Oct
const day = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`; };
// a Twonk whose on-chain record does not match its art (checked by eye, tools/art-flags.json). Misprints are a tier of
// their own, shown beside the rank and never inside it: the rank follows the record.
const KIND = { wrong: 'wrong-trait', blank: 'blank-record' };
const misprintOf = (f, n) => misprints?.misprints.find((m) => m.c === f.c && m.n === n) || null;
const kindCount = (m) => misprints.misprints.filter((x) => x.kind === m.kind).length;
const misprintBox = (m) => `
  <div class="r misp"><span>Misprint</span><b>1 of ${kindCount(m)}</b><small>${kindCount(m) === 1 ? `the only known ${KIND[m.kind]} misprint` : `${KIND[m.kind]} misprint (1 of ${misprints.misprints.length} known)`}</small></div>`;

// ---------- check it on the blockchain ----------
// Read live, in the visitor's browser: Twetch's API names the Twonk's current output, WhatsOnChain serves that raw
// transaction, and chain.js reads the record written in it. Nothing passes through True Twonk.
const chainBox = () => `
  <details class="chain"><summary>Check it on the blockchain</summary><div class="chain-body"><p class="fine">Reading the blockchain…</p></div></details>`;
function wireChain(out, f, row) {
  const box = out.querySelector('details.chain');
  if (!box) return;
  box.addEventListener('toggle', () => { if (box.open && !box.dataset.done) { box.dataset.done = '1'; factCheck(box.querySelector('.chain-body'), f, row); } });
}
const shortTx = (tx) => `${tx.slice(0, 10)}…${tx.slice(-6)}`;
async function factCheck(body, f, row) {
  const say = (html) => { body.innerHTML = html; };
  const n = row[0];
  try {
    const tok = await fetch(`https://api.twetch.com/v1/tokens/${f.c}/${n}`).then((r) => { if (!r.ok) throw new Error(`Twetch answered ${r.status}`); return r.json(); });
    const [tx, vout] = String(tok.state?.currentOutpoint || '').split(':');
    if (!tx) return say(`<p>Twetch names no transaction for this Twonk${tok.pending ? ', and marks it pending' : ''}.</p>`);
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${tx}/hex`);
    if (res.status === 404) {
      return say(`<p>Twetch ${tok.pending ? 'marks this Twonk pending and ' : ''}names transaction <code>${shortTx(tx)}</code>, but the blockchain has no such transaction (WhatsOnChain: not found). So there is no on-chain record.</p>`);
    }
    if (!res.ok) throw new Error(`WhatsOnChain answered ${res.status}`);
    const rec = chainRecord(await res.text(), +vout || 0);
    const link = `<a href="https://whatsonchain.com/tx/${tx}" target="_blank" rel="noopener">${shortTx(tx)}</a>`;
    if (!rec) return say(`<p>Transaction ${link} (output ${+vout || 0}) holds no record.</p>`);
    const j = rec.json;
    const attrs = traitsOf(j);
    const ours = (type) => { const t = f.types.findIndex((x) => x.trim() === String(type).trim()); const v = t < 0 ? -1 : row[T0 + t]; return v >= 0 ? String(f.traits[t][v][0]) : null; };
    const diffs = attrs.filter((a) => (ours(a.type) ?? '').trim() !== String(a.value).trim());
    // traits True Twonk shows that this record does not hold at all (Twetch's listing has them, the chain does not)
    const onChain = new Set(attrs.map((a) => String(a.type).trim()));
    const siteOnly = f.types.filter((t) => !onChain.has(t.trim()) && ours(t) != null);
    const names = (list) => list.map(esc).join(', ');
    const lit = (v) => `<code>${esc(JSON.stringify(v)).replace(/ +(?=&quot;$)/, (s) => ' '.repeat(s.length))}</code>`; // quoted, so stray spaces show; they hold the closing quote on their line
    const rows = attrs.map((a) => `<tr${diffs.includes(a) ? ' class="diff"' : ''}><td>${esc(a.type)}</td><td>${lit(a.value)}</td><td>${a.count != null ? fmt(a.count) : '–'}</td></tr>`).join('')
      + siteOnly.map((t) => `<tr class="diff"><td>${esc(t)}</td><td class="none">not in the record</td><td>–</td></tr>`).join('');
    const art = (f.art?.[n] || []).map(([type, record, shown]) => `<p class="flag hot">The art shows ${esc(shown)}; the chain says ${esc(type)} ${lit(record)}.</p>`).join('');
    say(`
      <p>Read just now from transaction ${link}, output ${+vout || 0}, via WhatsOnChain. This is the record as written on the blockchain.</p>
      <p class="chain-stored">Stored on chain: rank ${j.rank != null ? '#' + fmt(+j.rank) : 'none'}${j.rarity ? `, ${esc(j.rarity)}` : ''}${j.score != null ? `, score ${esc(j.score)}` : ''}.</p>
      ${rows ? `<table class="chain-t"><thead><tr><th>Trait</th><th>Value on chain</th><th>Count stored</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      ${attrs.length ? '' : '<p>The record on chain lists no traits.</p>'}
      <p class="fine">${diffs.length ? `On chain, ${names(diffs.map((a) => a.type))} differ${diffs.length === 1 ? 's' : ''} from what Twetch lists (marked). ` : attrs.length ? 'Every trait on chain matches what Twetch lists. ' : ''}${siteOnly.length ? `${names(siteOnly)} ${siteOnly.length === 1 ? 'is' : 'are'} in Twetch's listing but not in the on-chain record (marked). ` : ''}${attrs.some((a) => a.count != null) ? 'The counts are as the record stores them; True Twonk recounts its own.' : ''}</p>
      ${art}
      <details class="raw"><summary>The record, exactly as written</summary><pre>${esc(rec.text)}</pre></details>`);
  } catch (e) {
    say(`<p>Could not read the blockchain just now (${esc(e.message)}). Try again in a moment.</p>`);
    body.closest('details').dataset.done = '';
  }
}

function showMisprints() {
  if (!misprints) return;
  const list = misprints.misprints;
  const item = (m) => `
    <li class="mp">
      <a href="/t/${esc(m.slug)}/${m.n}">${m.image ? `<img src="${MEDIA}${m.image}" alt="${esc(m.name)}" loading="lazy" decoding="async">` : ''}</a>
      <span class="mp-t"><a href="/t/${esc(m.slug)}/${m.n}"><b>${esc(m.name)}</b></a>${m.name.includes('#') ? '' : ` <small>${esc(m.fleet)} #${m.n}</small>`}</span>
      <span class="mp-d">${m.kind === 'wrong'
        ? m.detail.map(([type, record, art]) => `${esc(type)}: the art shows ${esc(art)}, the record says ${esc(record)}.`).join(' ')
        : `Not on chain. ${m.twetch ? `Twetch shows #${fmt(m.twetch)}.` : 'Twetch shows no rank.'}`}</span>
    </li>`;
  const group = (kind, title) => {
    const g = list.filter((m) => m.kind === kind);
    return g.length ? `<h3>${title} (${g.length})</h3><ul class="mps">${g.map(item).join('')}</ul>` : '';
  };
  const out = $('#result');
  out.innerHTML = `
    <div class="misprints">
      <h2>Misprints</h2>
      <p>A misprint is a Twonk whose on-chain record does not match its art. Like misprinted banknotes, they can be collected as a tier of their own. They are shown here, not ranked: True Twonk ranks every Twonk by its record.</p>
      ${group('wrong', 'Wrong trait')}
      <p class="fine">Found by comparing each Twonk's art with its record, then checked by eye. Checked: ${misprints.checked.length} of ${misprints.of} collections, the pixel-art ones (${esc(misprints.checked.join(', '))}). The other ${misprints.of - misprints.checked.length} are not pixel art, which this check cannot read, so they may hold misprints not listed here.</p>
      ${(misprints.offChain || []).length ? `
      <h3>Not on the blockchain (${misprints.offChain.length})</h3>
      <p class="fine">Not misprints: there is no on-chain record to misprint. Twetch lists these Twonks, and shows a rank for some of them, but marks them pending with no owner, and no transaction exists for them (checked ${day(misprints.chainChecked)}).</p>
      <ul class="mps">${misprints.offChain.map((m) => item({ ...m, kind: 'off' })).join('')}</ul>` : ''}
    </div>`;
  document.title = 'Misprints · True Twonk';
  show();
}
// the deliberate glitch one-of-ones (Frog Cartel #1240, Naka Motor Club #2222, Rare Sirloins #1213): "Missing" traits by design
const missingPiece = (f, row) => f.types.filter((_, t) => { const v = row[T0 + t]; return v >= 0 && /^missing/i.test(f.traits[t][v][0]) && f.traits[t][v][2] === 1; }).length >= 3;
const img = (f, row, cls = '') => row && row[3]
  ? `<img class="${cls}" src="${MEDIA}${row[3]}" alt="${esc(nameOf(f, row[0]))}" loading="lazy" decoding="async">`
  : `<span class="${cls} noimg" aria-hidden="true"></span>`;
const nameOf = (f, n) => f.names[n] || `${f.name} #${n}`;
const T0 = 8; // value indexes start after 8 fields in a token row
const pct = (c, n) => { const p = (100 * c) / n; return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`; };

function steps(f, row) {
  const out = [];
  const [d1, d2, d3] = [row[5], row[6], row[7]];
  const say = (d, what) => { if (d) out.push(`<li><b class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}</b> ${what}</li>`); };
  say(d1, f.pooled ? `counted within ${esc(f.name)}, not across all ${fmt(f.pool)} that Twetch pools it with` : 'trait counts recounted from the Twonks themselves');
  say(d2, `${esc(f.unscored.join(' and '))} counted too (Twetch leaves ${f.unscored.length > 1 ? 'them' : 'it'} out of its rank)`);
  say(d3, 'burned Twonks no longer count');
  return out;
}

function traitRows(f, row) {
  const rows = [];
  for (let t = 0; t < f.types.length; t++) {
    const v = row[T0 + t]; if (v < 0) continue;
    const [raw, tier, c, reported, beats, ex, cAll] = f.traits[t][v];
    const value = /vaccination/i.test(f.types[t]) && /^\d+$/.test(raw) ? `${raw} dose${raw === '1' ? '' : 's'}` : raw;
    const notes = [];
    if (beats && ex) notes.push(`<span class="flag hot">Labelled ${tierName(tier)}, yet rarer than ${beats === 1 ? 'an' : fmt(beats)} ${beats === 1 ? tierName(ex[2]) : 'higher-labelled'} trait${beats === 1 ? '' : 's'}, like ${esc(f.traits[ex[0]][ex[1]][0])} (${tierName(ex[2])}, ${fmt(ex[3])})</span>`);
    // only a miscount over the same Twonks Twetch counts; a gap from leaving burned ones out is not Twetch's error
    if (reported != null && reported !== cAll && !f.pooled) notes.push(`<span class="flag">Twetch lists ${fmt(reported)}. The records show ${fmt(cAll)}.</span>`);
    if (f.unscored.includes(f.types[t])) notes.push(`<span class="flag">Not in Twetch's rank</span>`);
    if ((f.counts || []).includes(f.types[t])) notes.push(`<span class="flag">A count: shown, not ranked</span>`);
    const typo = (f.merged || []).find(([type, names]) => type === f.types[t] && names[0].trim() === String(raw).trim());
    if (typo) notes.push(`<span class="flag">Written two ways on record (one with a stray space), counted as one trait</span>`);
    const seen = (f.art?.[row[0]] || []).find(([type]) => type === f.types[t]);
    if (seen) notes.push(`<span class="flag hot">The art shows ${esc(seen[2])}. The on-chain record says ${esc(seen[1])}. Ranked by the record.</span>`);
    rows.push({ c, html: `
      <li class="lozenge trait">
        <span class="tt">${esc(f.types[t])}</span>
        <span class="tv">${esc(value)}${tier >= 0 ? ` <i class="tier t${tier}">${tierName(tier)}</i>` : ''}</span>
        <span class="tc"><b>${fmt(c)}</b> of ${fmt(f.n)} <small>${pct(c, f.n)}</small></span>
        ${notes.length ? `<span class="notes">${notes.join('')}</span>` : ''}
      </li>` });
  }
  return rows.sort((a, b) => a.c - b.c).map((r) => r.html).join('');
}

function ladder(f, row) {
  const top = f.top.map((n) => f.tok.find((r) => r[0] === n));
  const mine = row[2];
  const rung = (r, me) => `
    <li class="rung${me ? ' me' : ''}${r[2] <= 3 ? ' podium p' + r[2] : ''}">
      <span class="rk">${fmt(r[2])}</span>
      ${img(f, r, 'thumb')}
      <span class="nm">${esc(nameOf(f, r[0]))}${me ? ' <em>yours</em>' : ''}</span>
      <span class="tw">${r[4] ? `Twetch ${fmt(r[4])}` : 'Twetch: no rank'}</span>
    </li>`;
  let html = top.map((r) => rung(r, r[0] === row[0])).join('');
  if (mine > 3) html += `<li class="gap" aria-hidden="true"><span></span></li>${rung(row, true)}`;
  return `<ol class="ladder" aria-label="Top 3 in ${esc(f.name)}, and yours">${html}</ol>`;
}

function render(f, number) {
  const row = f.tok.find((r) => r[0] === number);
  const out = $('#result');
  if (!row) return missing(f, number);
  const name = nameOf(f, number);
  const twetchLink = `https://twetch.com/market/${f.c}?token=${number}`;

  if (f.burned[number] !== undefined) {
    const next = f.burned[number];
    const nextFleet = next && index.fleets.find((x) => x.name === next.split(' + ')[0]);
    out.innerHTML = `
      <div class="stage burned">
        <div class="spot">${img(f, row, 'hero')}</div>
        <div class="verdict">
          <h2>${esc(name)}</h2>
          <p class="big">Burned.</p>
          <p>It no longer counts in ${esc(f.name)}.${next ? ` It lives on in ${esc(next.replace(' + ', ' and '))} under the same number.` : ''}</p>
          ${nextFleet ? `<button class="lozenge go small" type="button" data-check="${esc(nextFleet.name)} ${number}"><span>Check ${esc(nextFleet.name)} #${number}</span></button>` : ''}
        </div>
      </div>`;
    sfx.down();
    return show();
  }
  if (!row[2]) {
    // no traits in Twetch's record: nothing to recount. Some of these are not on the blockchain at all
    // (tools/chain-status.json): Twetch lists them, marks them pending, and no transaction exists.
    const off = (f.offChain || []).includes(number);
    const twetch = row[1] ? `Twetch shows #${fmt(row[1])}` : 'Twetch shows no rank';
    if (!row[3]) return fail(`${name} has no traits in Twetch's record${row[1] ? `, though ${twetch}` : ''}, so there is nothing to recount.`);
    document.title = `${name} · True Twonk`;
    out.innerHTML = `
      <div class="stage blank">
        <div class="spot">${img(f, row, 'hero')}</div>
        <div class="verdict">
          <h2>${esc(name)}</h2>
          <div class="ranks">
            <div class="r twetch"><span>Twetch</span><b>${row[1] ? '#' + fmt(row[1]) : '–'}</b><small>${row[1] ? 'as Twetch prints it' : 'no rank'}</small></div>
            <div class="r"><span>True rank</span><b>None</b><small>${off ? 'not on chain' : 'no traits on record'}</small></div>
          </div>
          <p class="call">${off
            ? `Not on the blockchain. Twetch lists it and ${twetch.replace('Twetch shows', 'shows')}, but marks it pending with no owner, and no transaction exists for it (checked ${day(f.chainChecked)}). So there is no on-chain record to rank.`
            : 'Its record lists no traits, so there is nothing to recount.'}</p>
          <p class="acts"><a class="out" href="https://twetch.com/market/${f.c}?token=${number}" target="_blank" rel="noopener">View on Twetch</a>${off ? '<a class="out" href="/#misprints">Not-on-chain list</a>' : ''}</p>
          ${chainBox()}
        </div>
      </div>`;
    wireChain(out, f, row);
    sfx.same();
    return show();
  }
  const mp = misprintOf(f, number);

  const gained = row[4] ? row[4] - row[2] : null;
  const head = gained == null ? `<p class="call">Twetch shows no rank for ${esc(f.name)}, so this is the only one there is.</p>`
    : gained > 0 ? `<p class="call up">${fmt(gained)} place${gained === 1 ? '' : 's'} rarer than Twetch shows.</p>`
    : gained < 0 ? `<p class="call dn">${fmt(-gained)} place${gained === -1 ? '' : 's'} less rare than Twetch shows.</p>`
    : `<p class="call">Twetch got this one right.</p>`;
  const st = steps(f, row);
  const printed = row[1] && row[1] !== row[4]
    ? `<p class="fine">Twetch's page prints #${fmt(row[1])}${f.pooled ? `, a rank across the ${fmt(f.pool)} it pools ${esc(f.name)} with` : `, because it also numbers ${fmt(f.twetchPrintedOf - f.twetchOf)} Twonks it shows no traits for`}. Above is its place among ${fmt(f.twetchOf)} ${esc(f.name)}.</p>` : '';

  document.title = `${name}: true rank #${fmt(row[2])} · True Twonk`;
  out.innerHTML = `
    <div class="stage">
      <div class="spot">${img(f, row, 'hero')}</div>
      <div class="verdict">
        <h2>${esc(name)}</h2>
        <div class="ranks${mp ? ' three' : ''}">
          <div class="r twetch"><span>Twetch</span><b>${row[4] ? '#' + fmt(row[4]) : '–'}</b><small>${row[4] ? 'of ' + fmt(f.twetchOf) : 'no rank'}</small></div>
          <div class="r true"><span>True rank</span><b class="slam">#${fmt(row[2])}</b><small>of ${fmt(f.n)}, ${asOf()}</small></div>
          ${mp ? misprintBox(mp) : ''}
        </div>
        ${mp ? '<p class="fine"><a href="/#misprints">See all known misprints</a></p>' : ''}
        ${head}
        ${missingPiece(f, row) ? `<p class="fine">A one-of-one "Missing" piece: every trait is unique by design.</p>` : ''}
        ${st.length ? `<ul class="steps" aria-label="What moved it">${st.join('')}</ul>` : ''}
        ${printed}
        <p class="acts"><a class="out" href="${twetchLink}" target="_blank" rel="noopener">View on Twetch</a><button class="out share" type="button" data-share="${esc(shareUrl(f, number))}" data-title="${esc(`${name}: Twetch says ${row[4] ? '#' + fmt(row[4]) : 'no rank'}. Final answer?`)}">Share</button></p>
      </div>
      <div class="board">
        <h3>The three rarest in ${esc(f.name)}</h3>
        ${ladder(f, row)}
      </div>
    </div>
    <div class="traits-wrap">
      <h3>Its traits, rarest first</h3>
      <ul class="traits">${traitRows(f, row)}</ul>
      ${chainBox()}
      <details class="how">
        <summary>How the true rank is counted</summary>
        <p>Same formula Twetch uses for ${esc(f.name)} (${f.method === 'inv' ? 'rarity score: one over each trait\'s share, added up' : 'information content: how surprising each trait is, added up'}), with three changes:</p>
        <ul>
          <li>Every count is taken from the Twonks themselves. Twetch counts Signature "1 of 1" as one, though more frogs carry it.${f.pooled ? ` ${esc(f.name)} is counted within itself; Twetch counts it across ${fmt(f.pool)}.` : ''}</li>
          <li>Every trait counts${f.unscored.length ? `, ${esc(f.unscored.join(' and '))} included` : ''}.${f.counts?.length ? ` ${esc(f.counts.join(' and '))} is a count, shown but not ranked.` : ''}</li>
          <li>Burned Twonks no longer count${Object.keys(f.burned).length ? ` (${fmt(Object.keys(f.burned).length)} in ${esc(f.name)})` : ''}.</li>
        </ul>
        <p>A Twonk's place among ${fmt(f.n)} living ${esc(f.name)}, rarest first.</p>
      </details>
    </div>`;
  wireChain(out, f, row);
  (gained > 0 || gained == null) ? sfx.win() : gained < 0 ? sfx.down() : sfx.same();
  show();
}

// Collections made from another keep that one's numbers, so their numbers skip (Apu Cartel has 1,122 of 3,690).
const ORIGIN = { 'Apu Cartel': 'Frog Cartel', Graveyard: 'Frog Cartel', 'Lab Monkes': 'Astro Apes', 'Special Forces': 'Astro Apes' };
async function missing(f, number) {
  const nums = f.tok.map((r) => r[0]);
  const lo = nums[0], hi = nums[nums.length - 1];
  const gappy = hi - lo + 1 !== nums.length;
  const below = nums.filter((n) => n < number).pop(), above = nums.find((n) => n > number);
  const near = [below, above].filter((n) => n != null);
  const checks = near.map((n) => [`${f.name} ${n}`, `#${fmt(n)}`]);
  let msg;
  if (!gappy) msg = `${f.name} has no #${fmt(number)}. Its numbers run ${fmt(lo)} to ${fmt(hi)}.`;
  else {
    const from = ORIGIN[f.name];
    msg = from
      ? `${f.name} has no #${fmt(number)}. Its ${fmt(nums.length)} Twonks keep the number of the ${from} Twonk each came from, so the numbers skip.`
      : `${f.name} has no #${fmt(number)}. Its ${fmt(nums.length)} numbers skip between ${fmt(lo)} and ${fmt(hi)}.`;
    const origin = from && index.fleets.find((x) => x.name === from);
    if (origin && (await loadFleet(origin.c)).tok.some((r) => r[0] === number)) checks.unshift([`${from} ${number}`, `${from} #${fmt(number)}`]);
  }
  if (near.length) msg += ` Nearest: ${near.map((n) => '#' + fmt(n)).join(' and ')}.`;
  fail(msg, checks);
}

// ---------- links that open on one Twonk ----------
// /t/<collection>/<number> unfurls as that Twonk (src/worker.js); the old /#<collection>/<number> still opens too.
const slugOf = (f) => index.fleets.find((x) => x.c === f.c).slug;
const shareUrl = (f, number) => `${location.origin}/t/${slugOf(f)}/${number}`;
function linked() {
  const m = location.pathname.match(/^\/t\/([a-z0-9-]+)\/(\d+)\/?$/) || location.hash.match(/^#([a-z0-9-]+)\/(\d+)$/);
  const f = m && index.fleets.find((x) => x.slug === m[1]);
  return f ? `${f.name} ${m[2]}` : null;
}
async function share(b) {
  const { share: url, title } = b.dataset;
  // the system share sheet where there is one (phones), else the clipboard
  if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title, url }); } catch {} return; }
  try { await navigator.clipboard.writeText(url); b.textContent = 'Link copied'; }
  catch { b.textContent = url; }
  setTimeout(() => { b.textContent = 'Share'; }, 2200);
}

function show() {
  $('#err').hidden = true;
  const out = $('#result');
  out.hidden = false;
  out.classList.remove('in'); void out.offsetWidth; out.classList.add('in');
  out.querySelector('[data-check]')?.addEventListener('click', (e) => { $('#q').value = e.currentTarget.dataset.check; check(); });
  out.querySelector('[data-share]')?.addEventListener('click', (e) => share(e.currentTarget));
  out.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}
/** checks: [query, label] pairs offered as one-click buttons under the message. */
function fail(msg, checks = [], more = '') {
  document.title = 'True Twonk';
  const e = $('#err');
  e.innerHTML = esc(msg) + (checks.length ? `<span class="tries">${checks.map(([q, label]) => `<button type="button" class="try" data-q="${esc(q)}">Check ${esc(label)}</button>`).join('')}</span>` : '') + more;
  e.querySelectorAll('.try').forEach((b) => b.addEventListener('click', () => { $('#q').value = b.dataset.q; check(); }));
  e.hidden = false; $('#result').hidden = true; sfx.miss();
}

async function check() {
  if (!index) return;
  const p = parse($('#q').value);
  if (p.error) return fail(p.error);
  sfx.lock();
  const go = $('.go'); go.disabled = true; go.classList.add('busy');
  try {
    const f = await loadFleet(p.fleet.c);
    await new Promise((r) => setTimeout(r, reduced ? 0 : 650)); // the beat between "final answer" and the answer
    render(f, p.number);
    history.replaceState(null, '', `/t/${p.fleet.slug}/${p.number}`);
  } catch {
    fail('Could not load that collection. Check your connection and try again.');
  } finally { go.disabled = false; go.classList.remove('busy'); }
}

$('#ask').addEventListener('submit', (e) => { e.preventDefault(); check(); });

loadIndex().then(() => {
  if (location.hash === '#misprints') return showMisprints();
  const q = linked();
  if (q) { $('#q').value = q; check(); }
}).catch(() => fail('Could not load the collections. Reload to try again.'));
addEventListener('hashchange', () => { if (location.hash === '#misprints') showMisprints(); });
