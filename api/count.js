const { get, put, list } = require('@vercel/blob');

const PREFIX = 'signers.json';
const MAX_RETURN = 250;

function reply(res, status, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(status).json(data);
}

async function loadFile() {
  let blobs;
  try {
    blobs = await list({ prefix: PREFIX });
  } catch (e) {
    const err = new Error('list');
    err.cause = e && e.message;
    throw err;
  }
  if (!blobs || !blobs.blobs || blobs.blobs.length === 0) return [];
  try {
    const file = await get(blobs.blobs[0].url);
    const parsed = JSON.parse(await file.text());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    throw new Error('get');
  }
}

async function saveFile(signers) {
  await put(PREFIX, JSON.stringify(signers), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    const name = (body && body.name || '').trim();
    const city = (body && body.city || '').trim();
    if (name.length < 2) return reply(res, 400, { error: 'name' });

    let signers;
    try {
      signers = await loadFile();
    } catch (e) {
      return reply(res, 500, { error: 'storage', stage: e.message, msg: e.cause || '' });
    }
    const lower = name.toLowerCase();
    if (signers.some(s => (s.name || '').toLowerCase() === lower)) {
      return reply(res, 409, { error: 'dup', count: signers.length });
    }

    signers.push({
      name,
      city,
      status: body.status || 'citizen',
      statusLabel: body.statusLabel || '',
      ts: Date.now(),
    });

    try {
      await saveFile(signers);
    } catch (e) {
      return reply(res, 500, { error: 'storage', stage: 'put' });
    }

    return reply(res, 200, { ok: true, count: signers.length });
  }

  if (req.method === 'GET') {
    let signers;
    try {
      signers = await loadFile();
    } catch (e) {
      return reply(res, 500, { error: 'storage', stage: e.message, msg: e.cause || '' });
    }
    const recent = signers.slice(-MAX_RETURN);
    return reply(res, 200, { count: signers.length, signers: recent });
  }

  return reply(res, 405, { error: 'method' });
};