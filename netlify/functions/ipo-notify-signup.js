const { supabase } = require('./utils/supabaseClient');
const { wrapEmail, sendEmail } = require('./utils/brevo');

// Public endpoint — a lightweight opt-in for visitors who aren't
// subscribing yet but want to be notified about the Dangote IPO.
// Distinct from the site's general waitlist (which stays untouched).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: 'Malformed request body.' });
  }

  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const phone = (body.phone || '').trim();

  if (!email) {
    return jsonResponse(400, { error: 'Please provide your email address.' });
  }

  try {
    const { error: insertErr } = await supabase.from('ipo_notify_signups').insert({
      name: name || null,
      email,
      phone: phone || null
    });

    if (insertErr) {
      // Unique index on lower(email) — treat a duplicate signup as a
      // success rather than an error, since the outcome the visitor
      // wants (being on the list) is already true.
      if (insertErr.code === '23505' || (insertErr.message || '').includes('duplicate')) {
        return jsonResponse(200, { ok: true, alreadySubscribed: true });
      }
      throw insertErr;
    }

    try {
      const html = wrapEmail('You are on the list for Dangote IPO updates', `
        <h2 style="font-size:18px; margin:0 0 16px; color:#005E00;">You're on the list</h2>
        <p style="font-size:14px; color:#14231C; line-height:1.6; margin:0 0 12px;">Hi ${name || 'there'},</p>
        <p style="font-size:14px; color:#14231C; line-height:1.6;">We'll email you with updates on the Dangote Refinery IPO — including reminders and important dates. You can subscribe any time at tippingpoint.bglafrica.com/dangote-ipo/subscribe.</p>
      `);
      await sendEmail({ to: email, subject: "You're on the list for Dangote IPO updates", html });
    } catch (emailErr) {
      console.error('IPO notify-signup confirmation email failed:', emailErr);
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('ipo-notify-signup error:', err);
    return jsonResponse(500, { error: 'Something went wrong. Please try again.' });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
