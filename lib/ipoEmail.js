const { wrapEmail, button, sendEmail } = require('./brevo');
const { getAdminEmails } = require('./supabaseClient');

const SITE_URL = process.env.SITE_URL || 'https://tippingpoint.bglafrica.com';
const GREEN = '#005E00';
const MUTED = '#4B5B50';
const INK = '#14231C';

async function sendIpoSubmissionReceivedEmail({ applicantEmail, applicantName, subscriptionReference, numberOfUnits, amountPayable }) {
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${GREEN};">Dangote IPO subscription received</h2>
    <p style="font-size:14px; color:${INK}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${INK}; line-height:1.6; margin:0 0 12px;">
      We've received your subscription for the Dangote Refinery IPO. Once we confirm your payment, we'll let you know right away.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px; margin-bottom:16px;">
      <tr><td style="padding:4px 0; color:${MUTED};">Reference</td><td style="padding:4px 0; text-align:right; font-weight:bold;">${subscriptionReference}</td></tr>
      <tr><td style="padding:4px 0; color:${MUTED};">Units applied for</td><td style="padding:4px 0; text-align:right;">${numberOfUnits}</td></tr>
      <tr><td style="padding:4px 0; color:${MUTED};">Amount payable</td><td style="padding:4px 0; text-align:right;">₦${Number(amountPayable).toLocaleString()}</td></tr>
    </table>
    <p style="font-size:14px; color:${INK}; line-height:1.6;">If you haven't made payment yet, please do so and ensure your payment evidence was uploaded with your subscription.</p>
  `;
  const html = wrapEmail('Your Dangote IPO subscription has been received', body);
  return sendEmail({ to: applicantEmail, subject: 'Your Dangote IPO Subscription Has Been Received', html });
}

async function sendIpoPaymentConfirmedEmail({ applicantEmail, applicantName, subscriptionReference }) {
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${GREEN};">Payment confirmed</h2>
    <p style="font-size:14px; color:${INK}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${INK}; line-height:1.6; margin:0 0 12px;">
      Good news — we've confirmed payment for your Dangote Refinery IPO subscription. It's now moving forward for execution.
    </p>
    <p style="font-size:14px; color:${MUTED}; margin:0 0 4px;">Reference</p>
    <p style="font-size:16px; font-weight:bold; color:${GREEN}; margin:0 0 16px;">${subscriptionReference}</p>
    <p style="font-size:14px; color:${INK}; line-height:1.6;">We'll notify you again once your units are executed and allotted.</p>
  `;
  const html = wrapEmail('Your Dangote IPO payment has been confirmed', body);
  return sendEmail({ to: applicantEmail, subject: 'Your Dangote IPO Payment Has Been Confirmed', html });
}

async function sendIpoPaymentUnconfirmedEmail({ applicantEmail, applicantName, subscriptionReference, note }) {
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${GREEN};">We couldn't confirm your payment</h2>
    <p style="font-size:14px; color:${INK}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${INK}; line-height:1.6; margin:0 0 12px;">
      We reviewed your Dangote Refinery IPO subscription, but we weren't able to confirm your payment.
    </p>
    <p style="font-size:14px; color:${MUTED}; margin:0 0 4px;">Reference</p>
    <p style="font-size:15px; font-weight:bold; color:${INK}; margin:0 0 16px;">${subscriptionReference}</p>
    ${note ? `<p style="font-size:14px; color:${MUTED}; margin:0 0 4px;">Note</p><p style="font-size:14px; color:${INK}; line-height:1.6; margin:0 0 16px;">${note}</p>` : ''}
    <p style="font-size:14px; color:${INK}; line-height:1.6;">Please contact our helpline on 09154966790 or email dangotehelpdesk@bglafrica.com so we can help resolve this.</p>
  `;
  const html = wrapEmail('Update on your Dangote IPO subscription', body);
  return sendEmail({ to: applicantEmail, subject: 'Update on Your Dangote IPO Subscription', html });
}

async function sendIpoExecutedEmail({ applicantEmail, applicantName, subscriptionReference }) {
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${GREEN};">Your subscription has been executed</h2>
    <p style="font-size:14px; color:${INK}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${INK}; line-height:1.6; margin:0 0 12px;">
      Your Dangote Refinery IPO subscription has been executed and submitted for allotment.
    </p>
    <p style="font-size:14px; color:${MUTED}; margin:0 0 4px;">Reference</p>
    <p style="font-size:16px; font-weight:bold; color:${GREEN}; margin:0 0 16px;">${subscriptionReference}</p>
    <p style="font-size:14px; color:${INK}; line-height:1.6;">We'll let you know as soon as your units are allotted.</p>
  `;
  const html = wrapEmail('Your Dangote IPO subscription has been executed', body);
  return sendEmail({ to: applicantEmail, subject: 'Your Dangote IPO Subscription Has Been Executed', html });
}

async function sendIpoAllottedEmail({ applicantEmail, applicantName, subscriptionReference, unitsAllotted }) {
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${GREEN};">Units allotted 🎉</h2>
    <p style="font-size:14px; color:${INK}; margin:0 0 12px;">Hi ${applicantName || 'there'},</p>
    <p style="font-size:14px; color:${INK}; line-height:1.6; margin:0 0 12px;">
      Congratulations — your Dangote Refinery IPO units have been allotted.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px; margin-bottom:16px;">
      <tr><td style="padding:4px 0; color:${MUTED};">Reference</td><td style="padding:4px 0; text-align:right; font-weight:bold;">${subscriptionReference}</td></tr>
      ${unitsAllotted ? `<tr><td style="padding:4px 0; color:${MUTED};">Units allotted</td><td style="padding:4px 0; text-align:right; font-weight:bold;">${unitsAllotted}</td></tr>` : ''}
    </table>
    <p style="font-size:14px; color:${INK}; line-height:1.6;">Thank you for investing through BGL Securities.</p>
    ${button('Go to Tipping Point', SITE_URL)}
  `;
  const html = wrapEmail('Your Dangote IPO units have been allotted', body);
  return sendEmail({ to: applicantEmail, subject: 'Your Dangote IPO Units Have Been Allotted', html });
}

async function sendIpoInternalAlert({ subscriptionReference, investorType, applicantName, applicantEmail, subscriptionId, numberOfUnits, amountPayable }) {
  const typeLabel = investorType.charAt(0).toUpperCase() + investorType.slice(1);
  const adminUrl = `${SITE_URL}/admin`;
  const body = `
    <h2 style="font-size:18px; margin:0 0 16px; color:${GREEN};">New Dangote IPO subscription</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      <tr><td style="padding:4px 0; color:${MUTED};">Reference</td><td style="padding:4px 0; text-align:right; font-weight:bold;">${subscriptionReference}</td></tr>
      <tr><td style="padding:4px 0; color:${MUTED};">Investor type</td><td style="padding:4px 0; text-align:right;">${typeLabel}</td></tr>
      <tr><td style="padding:4px 0; color:${MUTED};">Applicant</td><td style="padding:4px 0; text-align:right;">${applicantName || '—'}</td></tr>
      <tr><td style="padding:4px 0; color:${MUTED};">Email</td><td style="padding:4px 0; text-align:right;">${applicantEmail || '—'}</td></tr>
      <tr><td style="padding:4px 0; color:${MUTED};">Units</td><td style="padding:4px 0; text-align:right;">${numberOfUnits}</td></tr>
      <tr><td style="padding:4px 0; color:${MUTED};">Amount payable</td><td style="padding:4px 0; text-align:right;">₦${Number(amountPayable).toLocaleString()}</td></tr>
    </table>
    ${button('View in admin', adminUrl)}
  `;
  const html = wrapEmail(`New Dangote IPO subscription — ${subscriptionReference}`, body);

  // Same "notify every admin" approach as the account-opening alert
  // in brevo.js — every Supabase Auth user is an admin, so this
  // reaches the whole team without a hand-maintained list. Falls
  // back to the original static pair only if the admin lookup fails.
  const adminEmails = await getAdminEmails();
  const to = adminEmails.length ? adminEmails : ['clientservices@bglafrica.com', 'dangotehelpdesk@bglafrica.com'];

  return sendEmail({
    to,
    subject: `New Dangote IPO Subscription — ${typeLabel} — ${subscriptionReference}`,
    html
  });
}

module.exports = {
  sendIpoSubmissionReceivedEmail,
  sendIpoPaymentConfirmedEmail,
  sendIpoPaymentUnconfirmedEmail,
  sendIpoExecutedEmail,
  sendIpoAllottedEmail,
  sendIpoInternalAlert
};
