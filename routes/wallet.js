import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import Nav from '../components/Nav';

export default function Wallet() {
  const { user, refreshUser } = useAuth();
  const [tab, setTab] = useState('overview');
  const [transactions, setTransactions] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState({ balance: 0, lockedBalance: 0, availableBalance: 0 });
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeNote, setRechargeNote] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [bankDetails, setBankDetails] = useState({ accountHolderName: '', accountNumber: '', ifscCode: '', bankName: '', upiId: '' });
  const [withdrawMethod, setWithdrawMethod] = useState('upi');
  const [qrCode, setQrCode] = useState(null); // ✅ Dynamic QR

  // ✅ Initial load + live polling. Every 5s we silently re-fetch balance,
  // transactions and pending requests (no spinner flash), so when the admin
  // approves/rejects a request the status + balance update on their own —
  // no manual refresh needed. The QR is only fetched on the first (non-silent)
  // load since it never changes during a session.
  useEffect(() => {
    fetchData();
    const id = setInterval(() => fetchData(true), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const reqs = [
        axios.get('/api/wallet/balance'),
        axios.get('/api/wallet/transactions'),
        axios.get('/api/wallet/pending-requests'),
      ];
      if (!silent) reqs.push(axios.get('/api/settings/qr-code')); // ✅ QR only on first load
      const [balRes, txRes, pendRes, qrRes] = await Promise.all(reqs);
      setBalance(balRes.data);
      setTransactions(txRes.data.transactions);
      setPending(pendRes.data);
      if (!silent && qrRes) setQrCode(qrRes.data.qrCode);
      refreshUser();
    } catch (err) {
      if (!silent) toast.error('Failed to load wallet data');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // ✅ One pending request per type. Derived from the live `pending` list, so it
  // flips back automatically (via polling) the moment the admin clears the request.
  const hasPendingRecharge = pending.some(p => p.type === 'recharge');
  const hasPendingWithdraw = pending.some(p => p.type === 'withdraw');

  const handleRechargeRequest = async (e) => {
    e.preventDefault();
    if (hasPendingRecharge) return toast.error('You already have a pending deposit request. Please wait for it to be processed.');
    if (!rechargeAmount || rechargeAmount < 10) return toast.error('Minimum recharge is ₹10');
    try {
      await axios.post('/api/wallet/recharge-request', { amount: parseFloat(rechargeAmount), paymentNote: rechargeNote });
      toast.success('Recharge request submitted! Admin will add balance after verifying.');
      setRechargeAmount(''); setRechargeNote('');
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to submit request');
    }
  };

  const handleWithdrawRequest = async (e) => {
    e.preventDefault();
    if (hasPendingWithdraw) return toast.error('You already have a pending withdrawal request. Please wait for it to be processed.');
    if (!withdrawAmount || withdrawAmount < 50) return toast.error('Minimum withdrawal is ₹50');
    if (withdrawAmount > balance.availableBalance) return toast.error('Insufficient balance');
    const details = withdrawMethod === 'upi' ? { upiId: bankDetails.upiId } : bankDetails;
    if (withdrawMethod === 'upi' && !bankDetails.upiId) return toast.error('Enter your UPI ID');
    if (withdrawMethod === 'bank' && (!bankDetails.accountNumber || !bankDetails.ifscCode)) return toast.error('Enter complete bank details');
    try {
      await axios.post('/api/wallet/withdraw-request', { amount: parseFloat(withdrawAmount), bankDetails: details });
      toast.success('Withdrawal request submitted! Admin will process within 1 hour.');
      setWithdrawAmount(''); setBankDetails({ accountHolderName: '', accountNumber: '', ifscCode: '', bankName: '', upiId: '' });
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to submit withdrawal');
    }
  };

  const txColor = (type) => {
    if (['recharge', 'game_win', 'game_unlock', 'refund'].includes(type)) return 'var(--green)';
    if (['game_loss', 'withdraw', 'platform_fee'].includes(type)) return 'var(--red)';
    return 'var(--text-muted)';
  };

  const txSign = (type) => ['recharge', 'game_win', 'refund'].includes(type) ? '+' : '-';
  const txLabel = { recharge: 'Recharge', withdraw: 'Withdrawal', game_win: 'Game Win', game_loss: 'Game Loss', platform_fee: 'Platform Fee', game_lock: 'Game Entry', game_unlock: 'Refund', refund: 'Refund' };

  return (
    <div style={{ paddingBottom: 'calc(72px + env(safe-area-inset-bottom))' }}>
      <Nav />
      <div className="page">
        <div style={{ marginTop: 20, marginBottom: 20 }} className="fade-in">
          <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Wallet</div>
          <h2 className="title-display" style={{ fontSize: 30, marginTop: 4, letterSpacing: '-0.03em' }}>Your money</h2>
        </div>

        <div className="card-premium fade-in" style={{ marginBottom: 16, textAlign: 'center', animationDelay: '0.05s' }}>
          <div className="stat-label" style={{ marginTop: 0 }}>Available Balance</div>
          <div className="title-display tabular-nums" style={{ fontSize: 52, marginTop: 8, marginBottom: 4, letterSpacing: '-0.04em', lineHeight: 1 }}>
            ₹{balance.availableBalance.toFixed(0)}
          </div>
          {balance.lockedBalance > 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>
              <span className="pill pill-red">₹{balance.lockedBalance} LOCKED</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'var(--surface)', borderRadius: 'var(--r-md)', padding: 4, border: '1px solid var(--border)' }}>
          {[['overview', 'History', '📋'], ['recharge', 'Add Money', '➕'], ['withdraw', 'Withdraw', '💸']].map(([key, label, icon]) => (
            <button key={key} onClick={() => setTab(key)}
              style={{
                flex: 1, padding: '10px 6px', border: 'none', borderRadius: 'var(--r-sm)',
                cursor: 'pointer', fontWeight: 700, fontSize: 12,
                transition: 'all 0.2s',
                background: tab === key ? 'var(--grad-gold)' : 'transparent',
                color: tab === key ? '#1A1A2E' : 'var(--text-muted)',
                boxShadow: tab === key ? '0 2px 8px rgba(244,196,48,0.3)' : 'none',
              }}>
              <span style={{ marginRight: 4 }}>{icon}</span>{label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div>
            {pending.length > 0 && (
              <div className="card" style={{ marginBottom: 16, borderColor: 'rgba(244,196,48,0.4)' }}>
                <h4 style={{ marginBottom: 12, color: 'var(--yellow)' }}>⏳ Pending Requests</h4>
                {pending.map(tx => (
                  <div key={tx._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <div>
                      <div style={{ fontWeight: 700, textTransform: 'capitalize' }}>{tx.type}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(tx.createdAt).toLocaleString()}</div>
                    </div>
                    <div style={{ fontWeight: 800, color: 'var(--yellow)' }}>₹{tx.amount} <span style={{ fontSize: 11, background: 'rgba(244,196,48,0.2)', borderRadius: 4, padding: '2px 6px' }}>PENDING</span></div>
                  </div>
                ))}
              </div>
            )}
            <div className="card">
              <h4 style={{ marginBottom: 14, fontWeight: 700, fontSize: 16 }}>Transaction History</h4>
              {loading ? (
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <span className="spinner" style={{ width: 24, height: 24, borderWidth: 2, display: 'inline-block' }} />
                </div>
              ) : transactions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 32 }}>
                  <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.4 }}>📭</div>
                  <div style={{ color: 'var(--text-soft)', fontSize: 14 }}>No transactions yet</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {transactions.map(tx => {
                    const isPositive = ['recharge', 'game_win', 'refund'].includes(tx.type);
                    return (
                      <div key={tx._id} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '12px', borderRadius: 'var(--r-sm)',
                        transition: 'background 0.2s',
                      }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{
                            width: 36, height: 36, borderRadius: 10,
                            background: isPositive ? 'rgba(52,211,153,0.12)' : 'rgba(255,70,85,0.12)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 16,
                          }}>
                            {isPositive ? '↓' : '↑'}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>{txLabel[tx.type] || tx.type}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                              {new Date(tx.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                              <span style={{ marginLeft: 6, color: tx.status === 'completed' || tx.status === 'approved' ? 'var(--green)' : tx.status === 'pending' ? 'var(--gold)' : 'var(--red)', fontWeight: 700, textTransform: 'uppercase', fontSize: 10 }}>
                                · {tx.status}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div className="tabular-nums" style={{ fontWeight: 800, fontSize: 15, color: txColor(tx.type) }}>
                            {txSign(tx.type)}₹{tx.amount}
                          </div>
                          <div className="tabular-nums" style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginTop: 1 }}>Bal: ₹{tx.balanceAfter}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'recharge' && (
          <div>
            <div className="card" style={{ marginBottom: 16, textAlign: 'center' }}>
              <h4 style={{ marginBottom: 12, fontWeight: 800 }}>Scan QR to Pay</h4>

              {/* ✅ Dynamic QR Code */}
              {qrCode ? (
                <img src={qrCode} alt="Payment QR"
                  style={{ width: 200, height: 200, borderRadius: 12, border: '3px solid var(--yellow)', objectFit: 'contain', background: '#fff' }} />
              ) : (
                <div style={{ width: 200, height: 200, borderRadius: 12, border: '3px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', margin: '0 auto', fontSize: 13, padding: 16, textAlign: 'center' }}>
                  ⏳ Payment QR not set yet.<br />Contact admin.
                </div>
              )}

              <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                1. Scan this QR and pay the amount<br />
                2. Take a screenshot of the payment<br />
                3. Submit request below with payment note<br />
                4. Admin will verify and add balance within 30 mins
              </p>
            </div>
            <div className="card">
              <h4 style={{ marginBottom: 16, fontWeight: 800 }}>Submit Recharge Request</h4>

              {/* ✅ One pending deposit at a time */}
              {hasPendingRecharge && (
                <div style={{
                  background: 'rgba(244,196,48,0.12)', border: '1px solid rgba(244,196,48,0.4)',
                  borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 16,
                  fontSize: 13, color: 'var(--yellow)', fontWeight: 600, lineHeight: 1.5,
                }}>
                  ⏳ You already have a pending deposit request. Please wait for the admin to process it before submitting another.
                </div>
              )}

              <form onSubmit={handleRechargeRequest}>
                <div className="form-group">
                  <label className="form-label">Amount (₹)</label>
                  <input className="form-input" type="number" placeholder="Enter amount you paid" min={10} value={rechargeAmount} onChange={e => setRechargeAmount(e.target.value)} disabled={hasPendingRecharge} required />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    {[100, 200, 500, 1000].map(a => (
                      <button key={a} type="button" onClick={() => setRechargeAmount(a)} className="btn btn-ghost btn-sm" disabled={hasPendingRecharge}>₹{a}</button>
                    ))}
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Payment Reference / UTR Number</label>
                  <input className="form-input" type="text" placeholder="Enter UTR / transaction reference" value={rechargeNote} onChange={e => setRechargeNote(e.target.value)} disabled={hasPendingRecharge} />
                </div>
                <button className="btn btn-primary btn-full" type="submit" disabled={hasPendingRecharge}>
                  {hasPendingRecharge ? '⏳ Request already pending' : 'Submit Recharge Request'}
                </button>
              </form>
            </div>
          </div>
        )}

        {tab === 'withdraw' && (
          <div className="card">
            <h4 style={{ marginBottom: 4, fontWeight: 800 }}>Withdraw Money</h4>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>Available: ₹{balance.availableBalance} • Min: ₹50 • Processed within 1 hr</p>

            {/* ✅ One pending withdrawal at a time */}
            {hasPendingWithdraw && (
              <div style={{
                background: 'rgba(244,196,48,0.12)', border: '1px solid rgba(244,196,48,0.4)',
                borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 16,
                fontSize: 13, color: 'var(--yellow)', fontWeight: 600, lineHeight: 1.5,
              }}>
                ⏳ You already have a pending withdrawal request. Please wait for the admin to process it before submitting another.
              </div>
            )}

            <form onSubmit={handleWithdrawRequest}>
              <div className="form-group">
                <label className="form-label">Amount (₹)</label>
                <input className="form-input" type="number" placeholder="Enter withdrawal amount" min={50} max={balance.availableBalance} value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} disabled={hasPendingWithdraw} required />
                {balance.availableBalance > 0 && (
                  <button type="button" onClick={() => setWithdrawAmount(balance.availableBalance)} className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} disabled={hasPendingWithdraw}>Withdraw All (₹{balance.availableBalance})</button>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Payment Method</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setWithdrawMethod('upi')} className={`btn btn-sm ${withdrawMethod === 'upi' ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1 }} disabled={hasPendingWithdraw}>UPI</button>
                  <button type="button" onClick={() => setWithdrawMethod('bank')} className={`btn btn-sm ${withdrawMethod === 'bank' ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1 }} disabled={hasPendingWithdraw}>Bank Transfer</button>
                </div>
              </div>
              {withdrawMethod === 'upi' ? (
                <div className="form-group">
                  <label className="form-label">UPI ID</label>
                  <input className="form-input" type="text" placeholder="yourname@upi" value={bankDetails.upiId} onChange={e => setBankDetails({ ...bankDetails, upiId: e.target.value })} disabled={hasPendingWithdraw} required />
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">Account Holder Name</label>
                    <input className="form-input" type="text" placeholder="Full name" value={bankDetails.accountHolderName} onChange={e => setBankDetails({ ...bankDetails, accountHolderName: e.target.value })} disabled={hasPendingWithdraw} required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Account Number</label>
                    <input className="form-input" type="text" placeholder="Bank account number" value={bankDetails.accountNumber} onChange={e => setBankDetails({ ...bankDetails, accountNumber: e.target.value })} disabled={hasPendingWithdraw} required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">IFSC Code</label>
                    <input className="form-input" type="text" placeholder="IFSC code" value={bankDetails.ifscCode} onChange={e => setBankDetails({ ...bankDetails, ifscCode: e.target.value })} disabled={hasPendingWithdraw} required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Bank Name</label>
                    <input className="form-input" type="text" placeholder="Bank name" value={bankDetails.bankName} onChange={e => setBankDetails({ ...bankDetails, bankName: e.target.value })} disabled={hasPendingWithdraw} />
                  </div>
                </>
              )}
              <button className="btn btn-primary btn-full" type="submit" disabled={hasPendingWithdraw}>
                {hasPendingWithdraw ? '⏳ Request already pending' : 'Submit Withdrawal Request'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
