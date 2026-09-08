const { supabase } = require('./utils/supabaseClient');

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — matches the frontend's own cap

// Merged from create-upload-url.js (account opening) and
// ipo-create-upload-url.js (Dangote IPO subscription) to stay under
// Vercel Hobby's 12-serverless-function-per-deployment cap. Both did
// exactly the same thing — mint a short-lived signed upload URL so the
// browser can upload directly to Supabase Storage, bypassing the
// platform's function request-size limit entirely — differing only in
// which bucket and whether a `person` field applies, so this
// dispatches on `domain` instead of duplicating the logic.
//
// The signed token itself is the authorization for that one upload —
// the browser's own Supabase session (anon key) needs no storage
// write permission at all.

const DOMAINS = {
  account: { bucket: 'application-documents', requiresPerson: true },
  ipo: { bucket: 'ipo-documents', requiresPerson: false }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  const { domain, sessionId, person, docKey, filename, mimeType, fileSize } = body;

  const config = DOMAINS[domain];
  if (!config) {
    return res.status(400).json({ error: `domain must be one of: ${Object.keys(DOMAINS).join(', ')}.` });
  }
  if (!sessionId || !docKey || !filename || (config.requiresPerson && !person)) {
    return res.status(400).json({
      error: config.requiresPerson
        ? 'sessionId, person, docKey, and filename are all required.'
        : 'sessionId, docKey, and filename are all required.'
    });
  }
  if (mimeType && !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return res.status(400).json({ error: 'Only PNG, JPG, or PDF files are accepted.' });
  }
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    return res.status(400).json({ error: `File exceeds the ${MAX_FILE_SIZE / (1024 * 1024)}MB limit.` });
  }

  const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '');
  const path = config.requiresPerson
    ? `pending/${safeSessionId}/${person}_${docKey}_${Date.now()}_${sanitizeFilename(filename)}`
    : `pending/${safeSessionId}/${docKey}_${Date.now()}_${sanitizeFilename(filename)}`;

  try {
    const { data, error } = await supabase.storage
      .from(config.bucket)
      .createSignedUploadUrl(path);

    if (error) throw error;

    return res.status(200).json({
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl
    });
  } catch (err) {
    console.error('upload-url error:', err);
    return res.status(500).json({ error: 'Could not prepare the upload. Please try again.' });
  }
};

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
}
