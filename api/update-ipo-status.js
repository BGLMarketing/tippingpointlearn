const { supabase } = require('./utils/supabaseClient');
const {
  sendIpoPaymentConfirmedEmail,
  sendIpoPaymentUnconfirmedEmail,
  sendIpoExecutedEmail,
  sendIpoAllottedEmail
} = require('./utils/ipoEmail');

const VALID_TRANSITIONS = ['payment_confirmed', 'payment_unconfirmed', 'pending_execution', 'executed', 'allotted'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = authHeader && authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token.' });
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
  const adminEmail = userData.user.email;

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  const { subscriptionId, newStatus, note, unitsAllotted } = body;

  if (!subscriptionId || !VALID_TRANSITIONS.includes(newStatus)) {
    return res.status(400).json({
      error: `subscriptionId and a valid newStatus (${VALID_TRANSITIONS.join(', ')}) are required.`
    });
  }
  if (newStatus === 'payment_unconfirmed' && (!note || note.trim().length < 5)) {
    return res.status(400).json({ error: 'A short note explaining why payment could not be confirmed is required.' });
  }
  if (newStatus === 'allotted' && !unitsAllotted) {
    return res.status(400).json({ error: 'Units allotted is required to mark a subscription as allotted.' });
  }

  try {
    const { data: subRow, error: fetchErr } = await supabase
      .from('ipo_subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .single();
    if (fetchErr || !subRow) {
      return res.status(404).json({ error: 'Subscription not found.' });
    }

    const update = { status: newStatus, status_changed_at: new Date().toISOString(), status_changed_by: adminEmail };
    if (note) update.admin_note = note;
    if (newStatus === 'allotted') update.units_allotted = unitsAllotted;

    const { error: updateErr } = await supabase
      .from('ipo_subscriptions')
      .update(update)
      .eq('id', subscriptionId);
    if (updateErr) throw updateErr;

    await supabase.from('ipo_subscription_status_history').insert({
      subscription_id: subscriptionId,
      status: newStatus,
      changed_by: adminEmail,
      note: note || null
    });

    if (subRow.applicant_email) {
      try {
        const common = {
          applicantEmail: subRow.applicant_email,
          applicantName: subRow.applicant_name,
          subscriptionReference: subRow.subscription_reference
        };
        if (newStatus === 'payment_confirmed') {
          await sendIpoPaymentConfirmedEmail(common);
        } else if (newStatus === 'payment_unconfirmed') {
          await sendIpoPaymentUnconfirmedEmail({ ...common, note });
        } else if (newStatus === 'executed') {
          await sendIpoExecutedEmail(common);
        } else if (newStatus === 'allotted') {
          await sendIpoAllottedEmail({ ...common, unitsAllotted });
        }
        // pending_execution intentionally sends no email — a quiet
        // intermediate step between payment confirmation and execution.
      } catch (emailErr) {
        console.error('IPO status-change notification email failed:', emailErr);
      }
    }

    return res.status(200).json({ ok: true, status: newStatus });
  } catch (err) {
    console.error('update-ipo-status error:', err);
    return res.status(500).json({ error: 'Something went wrong updating the subscription. Please try again.' });
  }
};
