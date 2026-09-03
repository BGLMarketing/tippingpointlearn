const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const BRAND = {
  green: '#005E00',
  paper: '#F7F8F4',
  ink: '#14231C',
  muted: '#4B5B50',
  // Must be a publicly reachable, absolute URL — email clients cannot
  // load a relative site path. Host the logo at this path in the site's
  // own repo/domain.
  logoUrl: process.env.LOGO_URL || 'https://tippingpoint.bglafrica.com/assets/BGL_Logo.png',
  siteUrl: process.env.SITE_URL || 'https://tippingpoint.bglafrica.com'
};

/**
 * Wraps inner body HTML in the shared BGL/Tipping Point branded
 * email layout: logo header, content area, and a footer with BGL's
 * registered office and regulatory line.
 */
function wrapEmail(preheader, bodyHtml) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BGL Securities</title>
  </head>
  <body style="margin:0; padding:0; background:${BRAND.paper}; font-family:Arial, Helvetica, sans-serif; color:${BRAND.ink};">
    <span style="display:none; max-height:0; overflow:hidden;">${preheader || ''}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper}; padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border-radius:8px; overflow:hidden; border:1px solid #DDE3D9;">
            <tr>
              <td style="padding:28px 32px; border-bottom:1px solid #DDE3D9;">
                <img src="${BRAND.logoUrl}" alt="BGL Securities Limited" height="32" style="display:block;">
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px; background:${BRAND.paper}; border-top:1px solid #DDE3D9;">
                <p style="margin:0 0 6px; font-size:12px; color:${BRAND.muted};">
                  BGL Securities Limited &middot; 21 Bourdillon Road, Ikoyi, Lagos
                </p>
                <p style="margin:0; font-size:11px; color:${BRAND.muted};">
                  BGL Securities Limited is Registered and Duly Regulated by The Securities and Exchange Commission, Nigeria.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

function button(label, href) {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px;">
    <tr>
      <td style="border-radius:24px; background:${BRAND.green};">
        <a href="${href}" style="display:inline-block; padding:12px 26px; font-size:14px; font-weight:bold; color:#FFFFFF; text-decoration:none; border-radius:24px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

async function sendBrevoEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('BREVO_API_KEY not set — skipping email send:', subject, to);
    return { skipped: true };
  }

  const payload = {
    sender: {
      name: process.env.BREVO_SENDER_NAME || 'BGL Securities',
      email: process.env.BREVO_SENDER_EMAIL || 'no-reply@bglafrica.com'
    },
    to: Array.isArray(to) ? to.map((email) => ({ email })) : [{ email: to }],
    subject,
    htmlContent: html
  };
  if (replyTo) payload.replyTo = { email: replyTo };

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Brevo send failed (${res.status}): ${errText}`);
  }

  return res.json();
}

/* ============================================================
   Submission-stage emails
   ============================================================ */

async function sendInternalNewSubmissionAlert({
  applicationReference,
  accountType,
  applicantName,
  applicantEmail,
  applicationId,
  fileCount
}) {
  const typeLabel = accountType.charAt(0).toUpperCase() + accountType.slice(1);
  const adminUrl = `${BRAND.siteUrl}/admin/applications/${applicationId}`;

  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${BRAND.green};">New account opening request</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      <tr><td style="padding:4px 0; color:${BRAND.muted};">Application ID</td><td style="padding:4px 0; text-align:right; font-weight:bold;">${applicationReference}</td></tr>
      <tr><td style="padding:4px 0; color:${BRAND.muted};">Account type</td><td style="padding:4px 0; text-align:right;">${typeLabel}</td></tr>
      <tr><td style="padding:4px 0; color:${BRAND.muted};">Applicant</td><td style="padding:4px 0; text-align:right;">${applicantName || '—'}</td></tr>
      <tr><td style="padding:4px 0; color:${BRAND.muted};">Email</td><td style="padding:4px 0; text-align:right;">${applicantEmail || '—'}</td></tr>
      <tr><td style="padding:4px 0; color:${BRAND.muted};">Documents uploaded</td><td style="padding:4px 0; text-align:right;">${fileCount}</td></tr>
    </table>
    ${button('View application', adminUrl)}
  `;

  const html = wrapEmail(`New ${typeLabel} account opening request — ${applicationReference}`, body);

  return sendBrevoEmail({
    to: ['clientservices@bglafrica.com', 'marketing@bglafrica.ng'],
    subject: `New Account Opening Request — ${typeLabel} — ${applicationReference}`,
    html
  });
}

async function sendApplicantConfirmationEmail({ applicantEmail, applicantName, applicationReference }) {
  const trackUrl = `${BRAND.siteUrl}/track-application?ref=${encodeURIComponent(applicationReference)}`;

  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${BRAND.green};">Application received</h2>
    <p style="font-size:14px; color:${BRAND.ink}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6; margin:0 0 12px;">
      Thank you for applying to open an account with BGL Securities. We've received your application and sent it to our team for review.
    </p>
    <p style="font-size:14px; color:${BRAND.muted}; margin:0 0 4px;">Application reference</p>
    <p style="font-size:16px; font-weight:bold; color:${BRAND.green}; margin:0 0 16px;">${applicationReference}</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6;">We'll email you as soon as there's an update.</p>
    ${button('Track your application', trackUrl)}
  `;

  const html = wrapEmail('Your BGL account opening application has been received', body);

  return sendBrevoEmail({
    to: applicantEmail,
    subject: "We've Received Your BGL Account Opening Request",
    html
  });
}

/* ============================================================
   Status-change emails (sent by update-application-status)
   ============================================================ */

async function sendApplicantUnderReviewEmail({ applicantEmail, applicantName, applicationReference }) {
  const trackUrl = `${BRAND.siteUrl}/track-application?ref=${encodeURIComponent(applicationReference)}`;

  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${BRAND.green};">Your application is under review</h2>
    <p style="font-size:14px; color:${BRAND.ink}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6; margin:0 0 12px;">
      Your BGL Securities account opening request has moved to review by our compliance team.
    </p>
    <p style="font-size:14px; color:${BRAND.muted}; margin:0 0 4px;">Application reference</p>
    <p style="font-size:16px; font-weight:bold; color:${BRAND.green}; margin:0 0 16px;">${applicationReference}</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6;">We'll notify you as soon as a decision is made.</p>
    ${button('Track your application', trackUrl)}
  `;

  const html = wrapEmail('Your BGL account opening request is under review', body);

  return sendBrevoEmail({
    to: applicantEmail,
    subject: 'Your BGL Account Opening Request Is Under Review',
    html
  });
}

async function sendApplicantOpenedEmail({ applicantEmail, applicantName, applicationReference, chn }) {
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${BRAND.green};">Your account has been opened</h2>
    <p style="font-size:14px; color:${BRAND.ink}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6; margin:0 0 12px;">
      Good news — your BGL account opening request has been completed and your account has been successfully opened.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px; margin-bottom:16px;">
      <tr><td style="padding:4px 0; color:${BRAND.muted};">Application reference</td><td style="padding:4px 0; text-align:right; font-weight:bold;">${applicationReference}</td></tr>
      <tr><td style="padding:4px 0; color:${BRAND.muted};">CHN</td><td style="padding:4px 0; text-align:right; font-weight:bold;">${chn}</td></tr>
    </table>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6;">Thank you for choosing BGL Securities.</p>
    ${button('Go to Tipping Point', BRAND.siteUrl)}
  `;

  const html = wrapEmail('Your BGL account has been opened', body);

  return sendBrevoEmail({
    to: applicantEmail,
    subject: 'Your BGL Account Has Been Opened',
    html
  });
}

async function sendApplicantRejectedEmail({ applicantEmail, applicantName, applicationReference, reason }) {
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${BRAND.green};">Update on your application</h2>
    <p style="font-size:14px; color:${BRAND.ink}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6; margin:0 0 12px;">
      We've reviewed your BGL account opening request, but we're unable to complete the application at this time.
    </p>
    <p style="font-size:14px; color:${BRAND.muted}; margin:0 0 4px;">Application reference</p>
    <p style="font-size:15px; font-weight:bold; color:${BRAND.ink}; margin:0 0 16px;">${applicationReference}</p>
    <p style="font-size:14px; color:${BRAND.muted}; margin:0 0 4px;">Reason</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6; margin:0 0 16px;">${reason}</p>
    <p style="font-size:14px; color:${BRAND.ink}; line-height:1.6;">If you'd like to correct the issue above and reapply, or if you have questions, our team is happy to help.</p>
    ${button('Start a new application', `${BRAND.siteUrl}/open-account`)}
  `;

  const html = wrapEmail('Update on your BGL account opening request', body);

  return sendBrevoEmail({
    to: applicantEmail,
    subject: 'Update on Your BGL Account Opening Request',
    html
  });
}

module.exports = {
  wrapEmail,
  button,
  sendBrevoEmail,
  sendInternalNewSubmissionAlert,
  sendApplicantConfirmationEmail,
  sendApplicantUnderReviewEmail,
  sendApplicantOpenedEmail,
  sendApplicantRejectedEmail
};
