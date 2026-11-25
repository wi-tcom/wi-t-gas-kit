'use strict';

/**
 * MailApp の偽物。送ったメールを sent に残す。
 * テスト用の操作：failNextSend(err)
 */
function createMailApp() {
  const sent = [];
  let sendError = null;
  return {
    sendEmail(message) {
      if (sendError) {
        const err = sendError;
        sendError = null;
        throw err;
      }
      if (!message || typeof message !== 'object' || !message.to || !message.subject) {
        throw new Error('sendEmail: to and subject are required');
      }
      sent.push({ ...message });
    },
    // --- テスト用 ---
    sent,
    failNextSend(err) {
      sendError = err;
    }
  };
}

module.exports = { createMailApp };
