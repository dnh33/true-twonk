// Read a Twonk's record straight from its blockchain transaction, so anyone can check it against the page.
// A Twetch Twonk's output script is a lock, then OP_RETURN, then the record as one JSON push
// ({"title", "number", "rank", "attributes": [{"trait_type", "value", "count", "rarity"}], ...}).
// Pure: works on raw transaction hex, in the browser and in tests.

const hexBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

function reader(b) {
  let i = 0;
  const need = (n) => { if (i + n > b.length) throw new Error('transaction ends early'); };
  const u8 = () => { need(1); return b[i++]; };
  const le = (n) => { need(n); let v = 0; for (let k = n - 1; k >= 0; k--) v = v * 256 + b[i + k]; i += n; return v; };
  const varint = () => { const f = u8(); return f < 0xfd ? f : f === 0xfd ? le(2) : f === 0xfe ? le(4) : le(8); };
  const take = (n) => { need(n); const s = b.subarray(i, i + n); i += n; return s; };
  return { u8, le, varint, take, get done() { return i >= b.length; } };
}

/** The outputs of a raw transaction: [{ sats, script }] with script as bytes. */
export function outputs(txHex) {
  const r = reader(hexBytes(txHex.trim()));
  r.le(4); // version
  const ins = r.varint();
  for (let k = 0; k < ins; k++) { r.take(32); r.le(4); r.take(r.varint()); r.le(4); }
  const outs = [];
  const n = r.varint();
  for (let k = 0; k < n; k++) { const sats = r.le(8); outs.push({ sats, script: r.take(r.varint()) }); }
  return outs;
}

/** The pushes after the first real OP_RETURN opcode (walking opcodes, so bytes inside a pushed hash never count). */
export function returnPushes(script) {
  const r = reader(script);
  const pushes = [];
  let after = false;
  while (!r.done) {
    const op = r.u8();
    let len = -1;
    if (op > 0 && op < 0x4c) len = op;
    else if (op === 0x4c) len = r.u8();
    else if (op === 0x4d) len = r.le(2);
    else if (op === 0x4e) len = r.le(4);
    if (len >= 0) { const data = r.take(len); if (after) pushes.push(data); }
    else if (op === 0x6a) after = true;
  }
  return pushes;
}

/** The record written in output `vout` of the transaction, as { text, json }, or null when it holds none. */
export function chainRecord(txHex, vout = 0) {
  const out = outputs(txHex)[vout];
  if (!out) return null;
  const dec = new TextDecoder();
  for (const push of returnPushes(out.script)) {
    const text = dec.decode(push);
    if (!text.trimStart().startsWith('{')) continue;
    try { return { text, json: JSON.parse(text) }; } catch { /* not JSON: keep looking */ }
  }
  return null;
}
