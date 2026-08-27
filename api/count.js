const { get, put, list } = require('@vercel/blob');
const crypto = require('crypto');

const PREFIX = 'signers.json';
const MAX_RETURN = 250;
const IP_SALT = 'ain-sefra-plaidoyer-2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || '';
}

function ipHash(req) {
  return crypto.createHash('sha256').update(IP_SALT + ':' + clientIp(req)).digest('hex');
}

function reply(res, status, data) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin');
  return res.status(status).json(data);
}

function isConflict(err) {
  const m = (err && err.message) || '';
  return /precondition|etag|if-match/i.test(m);
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
  if (!blobs || !blobs.blobs || blobs.blobs.length === 0) {
    return { signers: [], etag: null };
  }
  const target = blobs.blobs[0];
  try {
    const file = await get(target.url, { access: 'private', useCache: false });
    const parsed = JSON.parse(await new Response(file.stream).text());
    return {
      signers: Array.isArray(parsed) ? parsed : [],
      etag: target.etag || null,
    };
  } catch (e) {
    const err = new Error('get');
    err.cause = e && e.message;
    throw err;
  }
}

async function saveFile(signers, etag) {
  const options = {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
  };
  if (etag) options.ifMatch = etag;
  await put(PREFIX, JSON.stringify(signers), options);
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

    const signer = {
      name,
      city,
      status: body.status || 'citizen',
      statusLabel: body.statusLabel || '',
      h: ipHash(req),
      ts: Date.now(),
    };

    const MAX_ATTEMPTS = 4;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let current;
      try {
        current = await loadFile();
      } catch (e) {
        return reply(res, 500, { error: 'storage', stage: e.message });
      }
      if (current.signers.some((s) => (s.name || '').toLowerCase() === name.toLowerCase())) {
        return reply(res, 409, { error: 'dup', reason: 'name', count: current.signers.length });
      }
      if (current.signers.some((s) => s.h && s.h === signer.h)) {
        return reply(res, 409, { error: 'dup', reason: 'ip', count: current.signers.length });
      }
      current.signers.push(signer);
      try {
        await saveFile(current.signers, current.etag);
        return reply(res, 200, { ok: true, count: current.signers.length });
      } catch (e) {
        if (attempt < MAX_ATTEMPTS - 1 && isConflict(e)) {
          await sleep(150 * (attempt + 1));
          continue;
        }
        return reply(res, 500, { error: 'storage', stage: 'put', msg: (e && e.message) || '' });
      }
    }
  }

  if (req.method === 'GET') {
    let current;
    try {
      current = await loadFile();
    } catch (e) {
      return reply(res, 500, { error: 'storage', stage: e.message });
    }
    const recent = current.signers
      .slice(-MAX_RETURN)
      .map(({ h, ...s }) => s);
    return reply(res, 200, { count: current.signers.length, signers: recent });
  }

  if (req.method === 'DELETE') {
    const admin = req.headers['x-admin'] || '';
    if (admin !== process.env.BLOB_READ_WRITE_TOKEN) {
      return reply(res, 403, { error: 'forbidden' });
    }
    let current;
    try {
      current = await loadFile();
      await saveFile([], current.etag);
    } catch (e) {
      return reply(res, 500, { error: 'storage', stage: 'put' });
    }
    return reply(res, 200, { ok: true, count: 0 });
  }

  return reply(res, 405, { error: 'method' });
};