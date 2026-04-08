// utils/fcm.js — FCM helper using HTTP v1 API (no node-fetch dependency)
const { GoogleAuth } = require('google-auth-library');
const https = require('https');

const PROJECT_ID = 'ludo-app-86957';

const SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "ludo-app-86957",
  private_key_id: "5359124eb4338fd555b7389c0c7f776cfce5187a",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDVsePfjFDX+OQU\n5aeTXZIbgYXuFU/Qe9SGjn5ZhheoIF67gGjjljpxKfmaX3D1deWzx+2WpzyP4B5j\n+eiYbL/X/H5oVeBM3vkiwKmACuMjtq+mgP1gx87ZJ4vX6WMwFziUNL8r1IfF0/Ot\nKKofhufQgXQ2Vsxpw8TCspQU5ImEduDVda2rjOp2cvYlPaNMifu6703Xs+jhVbhT\nNSXrlBnV78ey4tt/e6GGE+S0lEiEBfXssMaJGFniAr91NFhGjkqfx8Z47dzF3H9k\nTvInAmzee/J54h66FYnwUp6We9SXpvcKp850hlbVQdeDbQwWUA4lRu2YQ4f03qWU\nDGSo71GHAgMBAAECggEABcySjQX/SaUg92o2Dns7FFEDA++DH3rEzTP/vMk1SiQ6\nvebhsc9pXZnQgr51T8v3xFW4Hl8CdzsTSA5HoB9PY3qgKY+vCxb/9s/4qZdiC52R\nDbkxZxd1BxKaKm1UekEfEXKO/48Acj9qvPe+CiX8k3133GOln3cnF0uGVjzPeI8+\nkrUH3n8Id1DVyh6oJuWXlyUwogpZsMc7xEZNplfhNde13dm2E8KtYQ19TPlyDav/\npTNAnWEfxWLN9nYs9/PmYq5+J4+TgPxn636jopO/oTxGcNsiWVyWv6165gOo1nyi\ni3TEq0U7ewTI1SYJ4iJ0R2dylMTgNkmkb/GWajtqGQKBgQD/8S6StgdPotSxT4Ep\ncWYzl+pDMLy/dcW3F+0RTQVTtkGNnyjT7ozkbgKng++EreZB1X2JOBARaVV0InUX\nyoebKVZY0ZG75D5I9WWF0CJdlZx5jelZFeP94pt+VVfvLlO1zBMjTQ8n1HfGpnR8\nM7e+LdMXYB2P/cAGFOkSxlxdDwKBgQDVvkMizMzu6QWs+6wr52lhHMozkgY+DqjB\nm7ZZwx1XHOKXahSURecEhyMb32zW9rgXho27wAyB+X5kHWWWHHfGVm8BQhBVe6X/\nv/E/1I2NKfBunG7rI4TNJhSa5LiuVS1kyO96R8ts3J8xVOSMsYjHdV5kQiiP8au5\nrn28SKc0CQKBgQCHuJyq3e44k69YK0Hh+SlqGJf4c2LT4J8s/XoQX5iAkLhoYksj\nP2/lPlUYAcXExPbCWHTOjDUxFntjL1aKfDK23A/W36L5UQqaY88nS3y9xbWJW/Cu\n9gXFvyIXtyf/RMDNOd+4K4fq5idx5xkEN+Sq69/xmF102um2D+actyWJjwKBgQDI\nD8QLKKKQ5G85kH+AwKN0EFx6lK1fHJ18SmEN94DY7uJwUwxcFGm9ZTfJeQEI2/lH\nm9vB5mpOpdZVouZY8OBzNqfEB6/+MzQXA/OtiSfM/3paLfXsBVziIEidCoSKOJO6\niBEO5XBUvtQKeqlJv0qFVyg4s2v//3Z64AY0W9SU8QKBgHAopXQR+z7YqcITPhjT\nprOgtbF5vn1RvH+54+PHUFX1BL6k1iP2VXZu6tWcIrzXRQ+3haBsgIAoAm1de6W1\nXHhNo77ccN+QLhnvZzKxqV5NlDF5IbSTn0kjtpPOofXoLrxFRPBL6f4s2kLnxApg\nF44DHFoW2cSd2BYJBiq3jbOY\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-fbsvc@ludo-app-86957.iam.gserviceaccount.com",
  client_id: "105532415453856816961",
  token_uri: "https://oauth2.googleapis.com/token",
};

// Get OAuth2 access token
async function getAccessToken() {
  const auth = new GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const client = await auth.getClient();
  const token  = await client.getAccessToken();
  return token.token;
}

// Native https POST helper (replaces node-fetch)
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method:   'POST',
      headers:  { ...headers, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, json: JSON.parse(raw) }); }
        catch { resolve({ ok: false, status: res.statusCode, json: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Send to single device
async function sendNotification(fcmToken, title, body, data = {}) {
  try {
    const accessToken = await getAccessToken();
    const FCM_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
    const res = await httpsPost(
      FCM_URL,
      { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      {
        message: {
          token: fcmToken,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
          webpush: {
            notification: { icon: '/logo192.png', badge: '/logo192.png', vibrate: [200, 100, 200] },
            fcm_options: { link: data.url || '/dashboard' },
          },
        },
      }
    );
    if (!res.ok) console.error('FCM error:', res.json);
    return res.json;
  } catch (err) {
    console.error('FCM send error:', err);
  }
}

// Send to multiple devices in parallel batches of 10
async function sendNotificationToAll(tokens, title, body, data = {}) {
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 10) chunks.push(tokens.slice(i, i + 10));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(token => sendNotification(token, title, body, data)));
  }
}

module.exports = { sendNotification, sendNotificationToAll };
