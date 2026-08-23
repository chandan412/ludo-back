/* ============================================================
   PAYMENT EXPIRY SCHEDULER

   Runs the two expiry sweeps in-process instead of paying for
   external cron executions.

   An n8n schedule trigger firing every 60 seconds costs ~1,440
   executions per day, which exhausts a 1,000/month allowance in
   under a day. This costs nothing and cannot stop working
   because a third-party trial ended.

   WIRE IT UP in server.js, AFTER mongoose has connected:

       const { startPaymentSchedulers } = require('./jobs/paymentScheduler');
       startPaymentSchedulers();

   No new npm packages needed.
   ============================================================ */

const RECHARGE_SWEEP_MS = 30 * 1000;   // player 1-minute expiry: check twice a minute
const BANK_SWEEP_MS = 60 * 1000;       // bank payment cleanup runs at 3 minutes, so
                                       // once a minute is plenty

let rechargeTimer = null;
let bankTimer = null;

// Guards against overlap. If a sweep is slow, the next tick is
// skipped rather than piling a second concurrent run on top of
// it — two sweeps touching the same pending recharges at once
// is exactly the kind of race that causes double-crediting.
let rechargeRunning = false;
let bankRunning = false;

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
    const { expirePendingRecharges } = require('../routes/paymentAutomation');
    const result = await expirePendingRecharges();

    if (
      result &&
      (result.rejected || result.approved || result.manual)
    ) {
      console.log(
        `Recharge sweep: checked ${result.checked}, ` +
        `approved ${result.approved || 0}, ` +
        `rejected ${result.rejected}, ` +
        `manual ${result.manual}`
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

async function runBankSweep() {
  if (bankRunning) {
    console.warn('Bank payment sweep still running, skipping this tick');
    return;
  }

  bankRunning = true;

  try {
    const { expireBankPayments } = require('../routes/paymentAutomation');
    const result = await expireBankPayments();

    if (result && result.expired) {
      console.log(`Bank payment sweep: expired ${result.expired}`);
    }

  } catch (err) {
    console.error('Bank payment sweep failed:', err.message);

  } finally {
    bankRunning = false;
  }
}

function startPaymentSchedulers() {
  if (rechargeTimer || bankTimer) {
    console.warn('Payment schedulers already started');
    return;
  }

  rechargeTimer = setInterval(runRechargeSweep, RECHARGE_SWEEP_MS);
  bankTimer = setInterval(runBankSweep, BANK_SWEEP_MS);

  // unref() lets the process exit cleanly on shutdown instead of
  // being held open by a pending timer.
  if (rechargeTimer.unref) rechargeTimer.unref();
  if (bankTimer.unref) bankTimer.unref();

  console.log(
    `Payment schedulers started ` +
    `(recharge every ${RECHARGE_SWEEP_MS / 1000}s, ` +
    `bank every ${BANK_SWEEP_MS / 1000}s)`
  );
}

function stopPaymentSchedulers() {
  if (rechargeTimer) {
    clearInterval(rechargeTimer);
    rechargeTimer = null;
  }

  if (bankTimer) {
    clearInterval(bankTimer);
    bankTimer = null;
  }

  console.log('Payment schedulers stopped');
}

module.exports = {
  startPaymentSchedulers,
  stopPaymentSchedulers
};
