// ── Realman Mailer — Google Apps Script ───────────────────────────────────
// SETUP:
//   1. Go to script.google.com → New project
//   2. Paste this entire file
//   3. Change MY_SECRET below to any password you choose
//   4. Click Deploy → New deployment → Web App
//      Execute as: Me | Who has access: Anyone → Deploy
//   5. Copy the Web App URL into the extension Settings

var MY_SECRET = 'change-this-to-your-own-password';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.secret !== MY_SECRET) {
      return json({ error: 'unauthorized' });
    }

    var subject    = body.subject    || '';
    var text       = body.body       || '';
    var recipients = body.recipients || [];
    var results    = [];

    for (var i = 0; i < recipients.length; i++) {
      var to = recipients[i].email;
      try {
        MailApp.sendEmail({
          to:       to,
          subject:  subject,
          body:     text,
          htmlBody: text.replace(/\n/g, '<br>')
        });
        results.push({ email: to, status: 'sent' });
      } catch (err) {
        results.push({ email: to, status: 'error', error: err.toString() });
      }
    }

    return json({ results: results });
  } catch (err) {
    return json({ error: err.toString() });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
