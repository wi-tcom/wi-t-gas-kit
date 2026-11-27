'use strict';

/**
 * MailApp の偽物。送ったメールを sent に残す。
 * 1 日に送れる宛先の数（getRemainingDailyQuota）は、送るたびに宛先の数だけ減る。
 * テスト用の操作：failNextSend(err)、setQuota(n)
 */
function createMailApp() {
  const sent = [];
  let sendError = null;
  let quota = 100;
  return {
    getRemainingDailyQuota: () => quota,
    sendEmail(message) {
      if (sendError) {
        const err = sendError;
        sendError = null;
        throw err;
      }
      if (!message || typeof message !== 'object' || !message.to || !message.subject) {
        throw new Error('sendEmail: to and subject are required');
      }
      const n = String(message.to).split(',').length;
      if (quota < n) throw new Error('Service invoked too many times for one day: email.');
      quota -= n;
      sent.push({ ...message });
    },
    // --- テスト用 ---
    sent,
    failNextSend(err) {
      sendError = err;
    },
    setQuota(n) {
      quota = n;
    }
  };
}

module.exports = { createMailApp };
