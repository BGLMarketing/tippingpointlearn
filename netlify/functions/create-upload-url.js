const { supabase } = require('./utils/supabaseClient');

const STORAGE_BUCKET = 'application-documents';
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — matches the frontend's own cap

// Returns a short-lived signed upload URL + token for one file. The
// browser then uploads the file bytes DIRECTLY to Supabase Storage
// using that token — the file never passes through this function or
// through submit-application, so neither is bound by Netlify's ~6MB
// function request-size limit. This function's own request/response
// is tiny (just metadata), so it runs in well under a second.
//
// The signed token itself is the authorization for that one upload —
// the browser's own Supabase session (anon key) needs no storage
// write permission at all, so this stays safe without opening up
// public write access to the bucket.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed request body.' });
  }

  const { sessionId, person, docKey, filename, mimeType, fileSize } = body;

  if (!sessionId || !person || !docKey || !filename) {
    return jsonResponse(400, { error: 'sessionId, person, docKey, and filename are all required.' });
  }
  if (mimeType && !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return jsonResponse(400, { error: 'Only PNG, JPG, or PDF files are accepted.' });
  }
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    return jsonResponse(400, { error: `File exceeds the ${MAX_FILE_SIZE / (1024 * 1024)}MB limit.` });
  }

  const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '');
  const path = `pending/${safeSessionId}/${person}_${docKey}_${Date.now()}_${sanitizeFilename(filename)}`;

  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(path);

    if (error) throw error;

    return jsonResponse(200, {
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl
    });
  } catch (err) {
    console.error('create-upload-url error:', err);
    return jsonResponse(500, { error: 'Could not prepare the upload. Please try again.' });
  }
};

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
