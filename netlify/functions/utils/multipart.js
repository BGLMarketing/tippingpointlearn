const Busboy = require('busboy');

/**
 * Parses a Netlify Function event body (multipart/form-data) into
 * plain text fields and uploaded files.
 *
 * Returns:
 *   {
 *     fields: { accountType: 'individual', data: '{...json...}' },
 *     files: [
 *       { fieldName: 'file__primary__validId', person: 'primary', docKey: 'validId',
 *         filename: 'id.jpg', mimeType: 'image/jpeg', content: Buffer }
 *     ]
 *   }
 */
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType = event.headers['content-type'] || event.headers['Content-Type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      reject(new Error('Expected multipart/form-data request'));
      return;
    }

    const busboy = Busboy({ headers: { 'content-type': contentType } });
    const fields = {};
    const files = [];

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (fieldName, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];

      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => reject(new Error(`File on field "${fieldName}" exceeds the size limit`)));
      stream.on('end', () => {
        // fieldName convention from the frontend: file__<person>__<docKey>
        const match = fieldName.match(/^file__(.+?)__(.+)$/);
        const person = match ? match[1] : 'unknown';
        const docKey = match ? match[2] : fieldName;

        files.push({
          fieldName,
          person,
          docKey,
          filename,
          mimeType,
          content: Buffer.concat(chunks)
        });
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files }));

    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'binary');

    busboy.end(bodyBuffer);
  });
}

module.exports = { parseMultipart };
