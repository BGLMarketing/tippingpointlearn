const { supabase } = require('./utils/supabaseClient');

const STORAGE_BUCKET = 'ipo-documents';
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// Same pattern as the account opening feature's create-upload-url.js:
// mints a short-lived signed upload URL so the browser can upload
// directly to Supabase Storage, bypassing the platform's function
// request-size limit entirely.

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

  const { sessionId, docKey, filename, mimeType, fileSize } = body;

  if (!sessionId || !docKey || !filename) {
    return res.status(400).json({ error: 'sessionId, docKey, and filename are all required.' });
  }
  if (mimeType && !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return res.status(400).json({ error: 'Only PNG, JPG, or PDF files are accepted.' });
  }
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    return res.status(400).json({ error: `File exceeds the ${MAX_FILE_SIZE / (1024 * 1024)}MB limit.` });
  }

  const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '');
  const path = `pending/${safeSessionId}/${docKey}_${Date.now()}_${sanitizeFilename(filename)}`;

  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(path);

    if (error) throw error;

    return res.status(200).json({
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl
    });
  } catch (err) {
    console.error('ipo-create-upload-url error:', err);
    return res.status(500).json({ error: 'Could not prepare the upload. Please try again.' });
  }
};

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
}
