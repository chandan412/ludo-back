// routes/notifications.js — backend
const express = require('express');
const router  = express.Router();
const { auth, adminAuth } = require('../middleware/auth');
const User = require('../models/User');
const { sendNotification, sendNotificationToAll } = require('../utils/fcm');

// POST /api/notifications/send — admin sends to all or specific user
router.post('/send', adminAuth, async (req, res) => {
  try {
    const { title, body, userId, url } = req.body;
    if (!title || !body) return res.status(400).json({ message: 'Title and body required' });

    if (userId) {
      // Send to specific user
      const user = await User.findById(userId);
      if (!user?.fcmToken) return res.status(400).json({ message: 'User has no notification token' });
      await sendNotification(user.fcmToken, title, body, { url: url || '/dashboard' });
      res.json({ message: `Notification sent to ${user.username}` });
    } else {
      // Send to ALL players
      const users = await User.find({ fcmToken: { $exists: true, $ne: null }, role: 'player' });
      if (users.length === 0) return res.status(400).json({ message: 'No players with notifications enabled' });

      const tokens = users.map(u => u.fcmToken);
      await sendNotificationToAll(tokens, title, body, { url: url || '/dashboard' });
      res.json({ message: `Notification sent to ${users.length} players` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to send notification' });
  }
});

module.exports = router;
