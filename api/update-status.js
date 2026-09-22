const { supabase } = require('../lib/supabaseClient');
const {
  sendApplicantUnderReviewEmail,
  sendApplicantOpenedEmail,
  sendApplicantRejectedEmail
} = require('../lib/brevo');
const {
  sendIpoPaymentConfirmedEmail,
  sendIpoPaymentUnconfirmedEmail,
  sendIpoExecutedEmail,
  sendIpoAllottedEmail
} = require('../lib/ipoEmail');

// Merged from update-application-status.js and update-ipo-status.js
// to stay under Vercel Hobby's 12-serverless-function-per-deployment
// cap. Both did the same shape of work (verify the caller is a
// logged-in admin, validate a status transition, update a row, log an
// audit-trail row, send a status-change email) against two different
// tables — this file shares just the admin auth check and otherwise
// keeps each handler's logic unchanged, dispatching on `domain`.

const APPLICATION_TRANSITIONS = ['under_review_client_service', 'under_review_compliance', 'account_opening_in_progress', 'opened', 'rejected'];
const IPO_TRANSITIONS = ['payment_confirmed', 'payment_unconfirmed', 'pending_execution', 'executed', 'allotted'];

// Which status an application can move to from its CURRENT status, and
// which admin role is required to make that move. Every stage requires
// an explicit approve or reject click from the role that owns it --
// simply opening/viewing an application never changes its status.
//
// under_review_client_service and under_review_compliance are BOTH
// "Compliance's" stage in the UI (displayed identically as "Under
// Compliance review") -- Compliance clicks Approve twice to walk an
// application through both internal statuses on the way to
// account_opening_in_progress.
const APPLICATION_TRANSITION_RULES = {
  submitted: {
    under_review_client_service: 'client_service',
    rejected: 'client_service'
  },
  under_review_client_service: {
    under_review_compliance: 'compliance',
    rejected: 'compliance'
  },
  under_review_compliance: {
    account_opening_in_progress: 'compliance',
    rejected: 'compliance'
  },
  account_opening_in_progress: {
    opened: 'account_opening',
    rejected: 'account_opening'
  },
  // Legacy rows still sitting at the old single-stage 'under_review'
  // status (pre-two-stage-pipeline) have no clean owner under the new
  // role system -- Account Opening can still move them to a terminal
  // state rather than leaving them permanently stuck.
  under_review: {
    opened: 'account_opening',
    rejected: 'account_opening'
  }
};

const ADMIN_ROLES = ['client_service', 'compliance', 'account_opening'];

// Hardcoded rather than a row in admin_roles on purpose: the super
// admin's identity has to exist independently of that table (otherwise
// there's a chicken-and-egg problem -- nobody could grant the first
// role without already having a way in), and keeping it a code-level
// constant means it can't be changed via the Manage Admins dropdown,
// which only ever offers the three ordinary roles. The super admin
// bypasses every per-role check below AND is the only one allowed to
// manage other admins' roles at all (see handleAdminRoles).
const SUPER_ADMIN_EMAIL = 'adeeyotemitope5@gmail.com';

async function getAdminRole(email) {
  const { data, error } = await supabase.from('admin_roles').select('role').eq('email', email.toLowerCase()).maybeSingle();
  if (error) {
    console.error('getAdminRole failed:', error);
    return null;
  }
  return data ? data.role : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- Authenticate the caller as a logged-in admin ----
  // The admin dashboard sends the Supabase Auth access token it already
  // holds from signing in. Verifying it here — server-side, with the
  // service role client — means only a real logged-in admin can trigger
  // a status change, an email, and an audit trail entry.
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

  if (body.domain === 'ipo') return handleIpoStatus(res, adminEmail, body);
  if (body.domain === 'admin_roles') return handleAdminRoles(res, adminEmail, body);
  if (body.domain === 'account') {
    if (body.action === 'edit_referred_by') return handleEditReferredBy(res, adminEmail, body);
    return handleApplicationStatus(res, adminEmail, body);
  }
  return res.status(400).json({ error: "domain must be 'account', 'ipo', or 'admin_roles'." });
};

async function handleAdminRoles(res, adminEmail, body) {
  if (adminEmail.toLowerCase() !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Only the super admin can manage admin roles.' });
  }

  const { action } = body;

  if (action === 'list') {
    try {
      const [{ data: authData, error: authErr }, { data: roleRows, error: roleErr }] = await Promise.all([
        supabase.auth.admin.listUsers({ perPage: 200 }),
        supabase.from('admin_roles').select('email, role')
      ]);
      if (authErr) throw authErr;
      if (roleErr) throw roleErr;

      const roleByEmail = {};
      (roleRows || []).forEach((r) => { roleByEmail[r.email.toLowerCase()] = r.role; });

      const admins = (authData.users || [])
        .map((u) => u.email)
        .filter(Boolean)
        .sort()
        .map((email) => ({ email, role: roleByEmail[email.toLowerCase()] || null }));

      return res.status(200).json({ admins });
    } catch (err) {
      console.error('update-status (admin_roles list) error:', err);
      return res.status(500).json({ error: 'Could not load admin roles.' });
    }
  }

  if (action === 'set_role') {
    const { targetEmail, role } = body;
    if (!targetEmail || (role && !ADMIN_ROLES.includes(role))) {
      return res.status(400).json({ error: `targetEmail and a valid role (${ADMIN_ROLES.join(', ')}, or empty to unassign) are required.` });
    }
    try {
      if (role) {
        const { error } = await supabase
          .from('admin_roles')
          .upsert({ email: targetEmail.toLowerCase(), role, updated_at: new Date().toISOString() }, { onConflict: 'email' });
        if (error) throw error;
      } else {
        const { error } = await supabase.from('admin_roles').delete().eq('email', targetEmail.toLowerCase());
        if (error) throw error;
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('update-status (admin_roles set_role) error:', err);
      return res.status(500).json({ error: "Could not update that admin's role." });
    }
  }

  return res.status(400).json({ error: "action must be 'list' or 'set_role'." });
}

async function handleEditReferredBy(res, adminEmail, body) {
  const { applicationId, referredBy, reason } = body;

  if (!applicationId) {
    return res.status(400).json({ error: 'applicationId is required.' });
  }
  if (!reason || reason.trim().length < 10) {
    return res.status(400).json({ error: 'A reason of at least 10 characters is required to edit this field.' });
  }

  try {
    const { data: appRow, error: fetchErr } = await supabase
      .from('account_opening_applications')
      .select('id, referred_by')
      .eq('id', applicationId)
      .single();
    if (fetchErr || !appRow) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    const oldValue = appRow.referred_by;
    const newValue = (referredBy || '').trim() || null;

    const { error: updateErr } = await supabase
      .from('account_opening_applications')
      .update({ referred_by: newValue })
      .eq('id', applicationId);
    if (updateErr) throw updateErr;

    // Not a status transition, but application_status_history has no
    // constraint tying it to the status CHECK list — reusing it here
    // keeps every change to an application in one place admin already
    // looks at, rather than a separate audit log nobody checks.
    await supabase.from('application_status_history').insert({
      application_id: applicationId,
      status: 'referred_by_updated',
      changed_by: adminEmail,
      reason: `Changed from "${oldValue || '(none)'}" to "${newValue || '(none)'}" — ${reason.trim()}`
    });

    return res.status(200).json({ ok: true, referredBy: newValue });
  } catch (err) {
    console.error('update-status (edit referred_by) error:', err);
    return res.status(500).json({ error: 'Something went wrong updating the referral field. Please try again.' });
  }
}

async function handleApplicationStatus(res, adminEmail, body) {
  const { applicationId, newStatus, chn, cscAccountNumber, adminNote, rejectionReason } = body;

  if (!applicationId || !APPLICATION_TRANSITIONS.includes(newStatus)) {
    return res.status(400).json({
      error: `applicationId and a valid newStatus (${APPLICATION_TRANSITIONS.join(', ')}) are required.`
    });
  }
  if (newStatus === 'opened' && (!chn || !cscAccountNumber)) {
    return res.status(400).json({ error: 'CHN and CSCS Account Number are both required to mark an application as opened.' });
  }
  if (newStatus === 'rejected' && (!rejectionReason || rejectionReason.trim().length < 10)) {
    return res.status(400).json({ error: 'A rejection reason of at least 10 characters is required.' });
  }

  try {
    const { data: appRow, error: fetchErr } = await supabase
      .from('account_opening_applications')
      .select('*')
      .eq('id', applicationId)
      .single();
    if (fetchErr || !appRow) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    // Validate this is actually a legal move from the application's
    // CURRENT status (not just that newStatus is somewhere in the
    // overall allowed list), and that the calling admin holds the role
    // authorized to make it. This is the real security boundary for
    // the role system -- the admin UI hides buttons the caller
    // shouldn't see, but this check is what actually stops a request
    // sent directly to the API from skipping a review stage.
    const rule = APPLICATION_TRANSITION_RULES[appRow.status];
    const requiredRole = rule ? rule[newStatus] : undefined;
    if (requiredRole === undefined) {
      return res.status(409).json({ error: `This application is at "${appRow.status}" and can't be moved to "${newStatus}".` });
    }
    if (requiredRole !== null && adminEmail.toLowerCase() !== SUPER_ADMIN_EMAIL) {
      const callerRole = await getAdminRole(adminEmail);
      if (callerRole !== requiredRole) {
        return res.status(403).json({
          error: callerRole
            ? `This action requires the ${requiredRole.replace('_', ' ')} role. Your role is ${callerRole.replace('_', ' ')}.`
            : `This action requires the ${requiredRole.replace('_', ' ')} role. Your admin account has no role assigned yet — ask another admin to assign one under Manage Admins.`
        });
      }
    }

    const update = { status: newStatus };
    if (newStatus === 'under_review_client_service') {
      update.review_started_at = new Date().toISOString();
      update.reviewed_by = adminEmail;
    } else if (newStatus === 'under_review_compliance') {
      // Second review stage — reviewed_by is overwritten to whoever
      // advanced it here; review_started_at is left as the original
      // client-service review start. The full per-stage history
      // (who, when, at which status) is captured in
      // application_status_history regardless, via the insert below.
      update.reviewed_by = adminEmail;
    } else if (newStatus === 'account_opening_in_progress') {
      // Compliance has approved — this just marks the handoff to
      // account opening itself. No new fields to set; the status
      // change and the status-history row are the record of it.
    } else if (newStatus === 'opened') {
      update.opened_at = new Date().toISOString();
      update.opened_by = adminEmail;
      update.chn = chn;
      update.csc_account_number = cscAccountNumber;
      if (adminNote) update.admin_note = adminNote;
    } else if (newStatus === 'rejected') {
      update.rejected_at = new Date().toISOString();
      update.rejected_by = adminEmail;
      update.rejection_reason = rejectionReason;
    }

    const { error: updateErr } = await supabase
      .from('account_opening_applications')
      .update(update)
      .eq('id', applicationId);
    if (updateErr) throw updateErr;

    await supabase.from('application_status_history').insert({
      application_id: applicationId,
      status: newStatus,
      changed_by: adminEmail,
      reason: newStatus === 'rejected' ? rejectionReason : (adminNote || null)
    });

    if (appRow.applicant_email) {
      try {
        if (newStatus === 'under_review_client_service') {
          await sendApplicantUnderReviewEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference
          });
        } else if (newStatus === 'under_review_compliance') {
          // Intentionally no customer email — this is an internal
          // handoff between review stages, not a change the
          // applicant needs to hear about. They already know their
          // application is under review from the previous stage.
        } else if (newStatus === 'account_opening_in_progress') {
          // Same reasoning — another internal handoff (compliance
          // clearance to the account-opening step itself), not
          // something the applicant needs a separate email about.
          // They'll hear from us once it's actually opened.
        } else if (newStatus === 'opened') {
          await sendApplicantOpenedEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference,
            chn,
            cscAccountNumber
          });
        } else if (newStatus === 'rejected') {
          await sendApplicantRejectedEmail({
            applicantEmail: appRow.applicant_email,
            applicantName: appRow.applicant_name,
            applicationReference: appRow.application_reference,
            reason: rejectionReason
          });
        }
      } catch (emailErr) {
        console.error('Status-change notification email failed:', emailErr);
      }
    }

    return res.status(200).json({ ok: true, status: newStatus });
  } catch (err) {
    console.error('update-status (account) error:', err);
    return res.status(500).json({ error: 'Something went wrong updating the application. Please try again.' });
  }
}

async function handleIpoStatus(res, adminEmail, body) {
  const { subscriptionId, newStatus, note, unitsAllotted } = body;

  if (!subscriptionId || !IPO_TRANSITIONS.includes(newStatus)) {
    return res.status(400).json({
      error: `subscriptionId and a valid newStatus (${IPO_TRANSITIONS.join(', ')}) are required.`
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
    console.error('update-status (ipo) error:', err);
    return res.status(500).json({ error: 'Something went wrong updating the subscription. Please try again.' });
  }
}
