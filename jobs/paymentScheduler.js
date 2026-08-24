/* ============================================================
   PAYMENT EXPIRY SCHEDULER

   Runs the recharge expiry sweep in-process instead of paying
   for external cron executions.

   There is deliberately NO bank payment sweep. A recorded credit
   is real money in the account and stays available to match
   until a player claims it or an admin disposes of it.

   An n8n schedule trigger firing every 60 seconds costs ~1,440
   executions per day, which exhausts a 1,000/month allowance in
   under a day. This costs nothing and cannot stop working
   because a third-party trial ended.

   WIRE IT UP in server.js, AFTER mongoose has connected:

       const { startPaymentSchedulers } = require('./jobs/paymentScheduler');
       startPaymentSchedulers();

   No new npm packages needed.
   ============================================================ */

// The recharge expiry window is 3 minutes. Polling twice a
// minute keeps the worst-case wait for a player close to the
// deadline itself rather than adding a whole extra interval on
// top of it.
const RECHARGE_SWEEP_MS = 30 * 1000;

let rechargeTimer = null;

// Guards against overlap. If a sweep is slow, the next tick is
// skipped rather than piling a second concurrent run on top of
// it — two sweeps touching the same pending recharges at once
// is exactly the kind of race that causes double-crediting.
let rechargeRunning = false;

/* ------------------------------------------------------------
   The sweeps are required lazily and called directly as
   functions rather than over HTTP. No network hop, no secret
   header, no chance of an auth misconfiguration silently
   stopping the cron.
   ------------------------------------------------------------ */

async function runRechargeSweep() {
  if (rechargeRunning) {
    console.warn('Recharge sweep still running, skipping this tick');
    return;
  }

  rechargeRunning = true;

  try {
    const { sweepPendingRecharges } = require('../routes/paymentAutomation');
    const result = await sweepPendingRecharges();

    if (
      result &&
      (result.rejected || result.approved || result.manual || result.awaitingManual)
    ) {
      console.log(
        `Recharge sweep: checked ${result.checked}, ` +
        `approved ${result.approved || 0}, ` +
        `rejected ${result.rejected}, ` +
        `manual ${result.manual}, ` +
        `awaitingManual ${result.awaitingManual || 0}`
      );
    }

  } catch (err) {
    // Never rethrow. An unhandled rejection inside a timer can
    // take the process down, and a failed sweep must not stop
    // future sweeps from running.
    console.error('Recharge sweep failed:', err.message);

  } finally {
    rechargeRunning = false;
  }
}

function startPaymentSchedulers() {
  if (rechargeTimer) {
    console.warn('Payment scheduler already started');
    return;
  }

  rechargeTimer = setInterval(runRechargeSweep, RECHARGE_SWEEP_MS);

  // unref() lets the process exit cleanly on shutdown instead of
  // being held open by a pending timer.
  if (rechargeTimer.unref) rechargeTimer.unref();

  console.log(
    `Payment scheduler started (recharge sweep every ${RECHARGE_SWEEP_MS / 1000}s)`
  );
}

function stopPaymentSchedulers() {
  if (rechargeTimer) {
    clearInterval(rechargeTimer);
    rechargeTimer = null;
  }

  console.log('Payment scheduler stopped');
}

module.exports = {
  startPaymentSchedulers,
  stopPaymentSchedulers
};
