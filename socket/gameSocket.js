import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import Nav from '../components/Nav';
import { getSocket } from '../socket/socket'; // ✅ use your existing singleton

const BET_AMOUNTS = [50, 100, 200, 500, 1000, 2000, 5000];

export default function Lobby() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();

  const [openGames, setOpenGames]           = useState([]);
  const [activeGame, setActiveGame]         = useState(null);
  const [loading, setLoading]               = useState(true);
  const [creating, setCreating]             = useState(false);
  const [joining, setJoining]               = useState(null);
  const [cancelling, setCancelling]         = useState(false);
  const [betAmount, setBetAmount]           = useState(100);
  const [customBet, setCustomBet]           = useState('');
  const [roomCode, setRoomCode]             = useState('');
  const [tab, setTab]                       = useState('browse');
  const [waitingSeconds, setWaitingSeconds] = useState(null); // ✅ live countdown

  const available = (user?.balance || 0) - (user?.lockedBalance || 0);

  // ============================
  // Socket listeners
  // ============================
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    // ✅ Live 2-min countdown from server
    socket.on('waiting-countdown', ({ secondsLeft }) => {
      setWaitingSeconds(secondsLeft);
    });

    // ✅ Game aborted — no opponent OR creator left
    socket.on('game-aborted', ({ message }) => {
      setActiveGame(null);
      setWaitingSeconds(null);
      refreshUser();
      toast.error(message || 'Game aborted. Bet refunded.', { duration: 5000 });
    });

    // ✅ Opponent joined — clear countdown
    socket.on('opponent-joined', ({ username }) => {
      setWaitingSeconds(null);
      toast.success(`${username} joined! Starting game...`);
    });

    return () => {
      // ✅ Only remove these listeners — don't kill the shared socket
      socket.off('waiting-countdown');
      socket.off('game-aborted');
      socket.off('opponent-joined');
    };
  }, []);

  // ============================
  // If user already has a waiting game on Lobby load,
  // rejoin its socket room so countdown keeps ticking
  // ============================
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !activeGame) return;
    if (activeGame.status === 'waiting') {
      socket.emit('join-room', { roomCode: activeGame.roomCode });
    }
  }, [activeGame]);

  // ============================
  // Data fetching
  // ============================
  useEffect(() => {
    fetchGames();
    fetchActiveGame();
    refreshUser();
    const interval = setInterval(fetchGames, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchGames = async () => {
    try {
      const res = await axios.get('/api/game/lobby');
      setOpenGames(res.data);
    } catch (err) {}
    finally { setLoading(false); }
  };

  const fetchActiveGame = async () => {
    try {
      const res = await axios.get('/api/game/my-games/history');
      const found = res.data.find(
        g => g.status === 'waiting' || g.status === 'active'
      );
      setActiveGame(found || null);
    } catch (err) {
      console.error('fetchActiveGame error:', err);
    }
  };

  // ============================
  // Actions
  // ============================
  const handleCancelGame = async () => {
    if (!activeGame) return;
    setCancelling(true);
    try {
      await axios.post(`/api/game/cancel/${activeGame.roomCode}`);
      setActiveGame(null);
      setWaitingSeconds(null);
      refreshUser();
      toast.success('Game cancelled. Bet refunded.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cannot cancel this game');
    } finally {
      setCancelling(false);
    }
  };

  const handleCreate = async () => {
    if (activeGame) {
      toast.error('You already have an active game!', { icon: '⚠️' });
      return;
    }
    const amount = customBet ? parseFloat(customBet) : betAmount;
    if (!amount || amount < 10) return toast.error('Minimum bet is ₹10');
    if (amount > available) return toast.error(`Insufficient balance. Available: ₹${available}`);

    setCreating(true);
    try {
      const res = await axios.post('/api/game/create', { betAmount: amount });
      const newRoomCode = res.data.game.roomCode;

      // ✅ Tell server this socket is the creator → starts 2-min timer on backend
      const socket = getSocket();
      if (socket) {
        socket.emit('created-room', { roomCode: newRoomCode });
        // ✅ Also post this game as an invite card into the global chat, so players
        // browsing chat can see it and join. (Same event GameChat uses.)
        socket.emit('send-invite', { betAmount: amount, roomCode: newRoomCode });
      }

      toast.success(`Room created! Code: ${newRoomCode}`);
      navigate(`/game/${newRoomCode}`);
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to create game';
      toast.error(msg);
      if (msg.toLowerCase().includes('active game')) fetchActiveGame();
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async (code) => {
    setJoining(code);
    try {
      const res = await axios.post(`/api/game/join/${code}`);
      toast.success('Joined! Game starting...');
      navigate(`/game/${res.data.game.roomCode}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to join game');
    } finally {
      setJoining(null);
    }
  };

  const handleJoinByCode = async (e) => {
    e.preventDefault();
    if (!roomCode.trim()) return toast.error('Enter room code');
    handleJoin(roomCode.trim().toUpperCase());
  };

  // ============================
  // Countdown display  e.g. 87 → "1:27"
  // ============================
  const formatCountdown = (secs) => {
    if (secs === null || secs === undefined) return null;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // ============================
  // Render
  // ============================
  return (
    <div style={{ paddingBottom: 'calc(72px + env(safe-area-inset-bottom))' }}>
      <Nav />
      <div className="page">
        <div style={{ marginTop: 20, marginBottom: 20 }} className="fade-in">
          <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Game Lobby</div>
          <h2 className="title-display" style={{ fontSize: 30, marginTop: 4, letterSpacing: '-0.03em' }}>
            Find your match
          </h2>
          <p style={{ color: 'var(--text-soft)', marginTop: 6, fontSize: 14 }}>
            Balance: <strong style={{ color: 'var(--gold)' }}>₹{available.toFixed(0)}</strong>
          </p>
        </div>

        {/* ============================
            Active Game Banner
        ============================ */}
        {activeGame && (
          <div style={{
            background: activeGame.status === 'active'
              ? 'linear-gradient(135deg, rgba(39,174,96,0.2) 0%, rgba(39,174,96,0.05) 100%)'
              : 'linear-gradient(135deg, rgba(241,196,15,0.2) 0%, rgba(241,196,15,0.05) 100%)',
            border: `2px solid ${activeGame.status === 'active' ? 'var(--green)' : 'var(--yellow)'}`,
            borderRadius: 14,
            padding: '14px 16px',
            marginBottom: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ flex: 1 }}>
                {/* Status dot + label */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div style={{
                    width: 9, height: 9, borderRadius: '50%',
                    background: activeGame.status === 'active' ? 'var(--green)' : 'var(--yellow)',
                    animation: 'pulse 1.5s infinite',
                  }} />
                  <span style={{ fontWeight: 800, fontSize: 14, color: activeGame.status === 'active' ? 'var(--green)' : 'var(--yellow)' }}>
                    {activeGame.status === 'active' ? '🟢 Game in Progress' : '⏳ Waiting for Opponent'}
                  </span>
                </div>

                {/* Room + bet */}
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Room: <strong style={{ color: 'var(--text)', letterSpacing: 2 }}>{activeGame.roomCode}</strong>
                  {' • '}
                  Bet: <strong style={{ color: 'var(--yellow)' }}>₹{activeGame.betAmount}</strong>
                </div>

                {/* ✅ Live countdown + progress bar */}
                {activeGame.status === 'waiting' && waitingSeconds !== null && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      Auto-cancels in
                    </span>
                    <span style={{
                      fontWeight: 800,
                      fontSize: 14,
                      fontVariantNumeric: 'tabular-nums',
                      color: waitingSeconds <= 30 ? 'var(--red)' : 'var(--yellow)',
                      minWidth: 36,
                    }}>
                      {formatCountdown(waitingSeconds)}
                    </span>
                    <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${(waitingSeconds / 120) * 100}%`,
                        background: waitingSeconds <= 30 ? 'var(--red)' : 'var(--yellow)',
                        borderRadius: 4,
                        transition: 'width 1s linear, background 0.3s',
                      }} />
                    </div>
                  </div>
                )}
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-green btn-sm"
                  onClick={() => navigate(`/game/${activeGame.roomCode}`)}
                  style={{ fontWeight: 800 }}
                >
                  ▶ {activeGame.status === 'active' ? 'Rejoin' : 'Enter Room'}
                </button>
                {activeGame.status === 'waiting' && (
                  <button className="btn btn-red btn-sm" onClick={handleCancelGame} disabled={cancelling}>
                    {cancelling ? '...' : '✕ Cancel'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab Switcher */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'var(--surface)', borderRadius: 'var(--r-md)', padding: 4, border: '1px solid var(--border)' }}>
          {[['browse', 'Browse', '🏆'], ['create', 'Create', '➕'], ['join', 'Join', '🔑']].map(([key, label, icon]) => (
            <button key={key} onClick={() => setTab(key)}
              style={{
                flex: 1, padding: '10px 6px', border: 'none', borderRadius: 'var(--r-sm)',
                cursor: 'pointer', fontWeight: 700, fontSize: 13,
                transition: 'all 0.2s',
                background: tab === key ? 'var(--grad-gold)' : 'transparent',
                color: tab === key ? '#1A1A2E' : 'var(--text-muted)',
                boxShadow: tab === key ? '0 2px 8px rgba(244,196,48,0.3)' : 'none',
              }}>
              <span style={{ marginRight: 6 }}>{icon}</span>{label}
            </button>
          ))}
        </div>

        {/* Browse Tab */}
        {tab === 'browse' && (
          <div>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading games...</div>
            ) : openGames.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🎲</div>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>No open games right now</div>
                <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 14 }}>Create a game and wait for an opponent!</p>
                <button className="btn btn-primary" onClick={() => setTab('create')}>Create Game</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {openGames.map(game => (
                  <div key={game._id} className="card card-hover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                      <div style={{
                        width: 44, height: 44, borderRadius: 12,
                        background: 'var(--grad-gold)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#1A1A2E', fontWeight: 800, fontSize: 14,
                        flexShrink: 0,
                        boxShadow: '0 4px 12px rgba(244,196,48,0.25)',
                      }}>
                        {game.createdBy?.username?.charAt(0).toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontWeight: 800, fontSize: 18, fontFeatureSettings: '"tnum"' }}>₹{game.betAmount}</span>
                          <span className="pill pill-green">WIN +₹{Math.floor(game.betAmount * 0.95)}</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <strong style={{ color: 'var(--text-soft)' }}>{game.createdBy?.username}</strong> · {game.createdBy?.gamesWon}W/{game.createdBy?.gamesPlayed}P
                        </div>
                      </div>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleJoin(game.roomCode)}
                      disabled={joining === game.roomCode || game.betAmount > available}
                      style={{ flexShrink: 0 }}
                    >
                      {joining === game.roomCode ? '...' : game.betAmount > available ? 'Low ₹' : 'Join'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Create Tab */}
        {tab === 'create' && (
          <div className="card">
            {activeGame ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>You already have an active game</div>
                <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 20 }}>
                  Finish or cancel your current game before creating a new one.
                </p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <button className="btn btn-green" onClick={() => navigate(`/game/${activeGame.roomCode}`)} style={{ fontWeight: 800 }}>
                    ▶ {activeGame.status === 'active' ? 'Rejoin Game' : 'Enter Room'}
                  </button>
                  {activeGame.status === 'waiting' && (
                    <button className="btn btn-red" onClick={handleCancelGame} disabled={cancelling}>
                      {cancelling ? 'Cancelling...' : '✕ Cancel Game'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <h4 style={{ marginBottom: 14, fontWeight: 700, fontSize: 16 }}>Choose Bet Amount</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
                  {BET_AMOUNTS.map(a => {
                    const isSelected = betAmount === a && !customBet;
                    return (
                      <button key={a} onClick={() => { setBetAmount(a); setCustomBet(''); }}
                        style={{
                          padding: '14px 8px',
                          display: 'flex', flexDirection: 'column', gap: 2,
                          background: isSelected ? 'var(--grad-gold)' : 'var(--surface)',
                          color: isSelected ? '#1A1A2E' : 'var(--text)',
                          border: isSelected ? '1px solid transparent' : '1px solid var(--border)',
                          borderRadius: 'var(--r-md)',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          fontFamily: 'inherit',
                          boxShadow: isSelected ? '0 4px 16px rgba(244,196,48,0.35)' : 'none',
                        }}>
                        <span style={{ fontWeight: 800, fontSize: 17, fontFeatureSettings: '"tnum"' }}>₹{a}</span>
                        <span style={{ fontSize: 11, opacity: 0.75, fontWeight: 600 }}>Win +₹{Math.floor(a * 0.95)}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="form-group">
                  <label className="form-label">Custom amount</label>
                  <input className="form-input" type="number" placeholder="Min ₹10" value={customBet} onChange={e => setCustomBet(e.target.value)} min={10} />
                </div>
                <div style={{ background: 'var(--grad-gold-soft)', border: '1px solid var(--border-gold)', borderRadius: 'var(--r-md)', padding: 14, marginBottom: 16, fontSize: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ color: 'var(--text-soft)' }}>Your bet</span>
                    <span style={{ fontWeight: 700 }}>₹{customBet || betAmount}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ color: 'var(--text-soft)' }}>Opponent's bet</span>
                    <span style={{ fontWeight: 700 }}>₹{customBet || betAmount}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ color: 'var(--text-soft)' }}>Platform fee (5%)</span>
                    <span style={{ color: 'var(--red)', fontWeight: 700 }}>-₹{Math.floor((customBet || betAmount) * 0.05)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-gold)', paddingTop: 8, marginTop: 4 }}>
                    <span style={{ color: 'var(--text)', fontWeight: 700 }}>Net win</span>
                    <span style={{ color: 'var(--green)', fontWeight: 800, fontSize: 16 }}>+₹{Math.floor((customBet || betAmount) * 0.95)}</span>
                  </div>
                </div>
                <button className="btn btn-primary btn-lg btn-full" onClick={handleCreate} disabled={creating || (customBet || betAmount) > available}>
                  {creating ? 'Creating...' : available < (customBet || betAmount) ? 'Insufficient Balance' : `▶ Create Game · ₹${customBet || betAmount}`}
                </button>
                {available < 100 && (
                  <p style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
                    Low balance? <a href="/wallet" style={{ color: 'var(--gold)' }}>Add money →</a>
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Join Tab */}
        {tab === 'join' && (
          <div className="card">
            <h4 style={{ marginBottom: 8, fontWeight: 800 }}>Join with Room Code</h4>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 20 }}>Ask your friend for their room code</p>
            <form onSubmit={handleJoinByCode}>
              <div className="form-group">
                <label className="form-label">Room Code</label>
                <input className="form-input" type="text" placeholder="e.g. ABC123" value={roomCode}
                  onChange={e => setRoomCode(e.target.value.toUpperCase())} maxLength={6}
                  style={{ letterSpacing: 4, fontWeight: 800, fontSize: 20, textAlign: 'center' }} required />
              </div>
              <button className="btn btn-primary btn-full" type="submit" disabled={!!joining}>
                {joining ? 'Joining...' : 'Join Game'}
              </button>
            </form>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%   { opacity: 1; transform: scale(1); }
          50%  { opacity: 0.5; transform: scale(1.4); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
