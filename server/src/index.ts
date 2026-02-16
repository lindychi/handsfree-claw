import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { createServer } from 'http';
import { nanoid } from 'nanoid';
import Database from 'better-sqlite3';
import { Resend } from 'resend';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ==================== Database ====================
const db = new Database(process.env.DB_PATH || './data/handsfree.db');

// 테이블 생성
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS pairings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gateway_token TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_pairings_user ON pairings(user_id);
  CREATE INDEX IF NOT EXISTS idx_pairings_token ON pairings(gateway_token);
`);

// ==================== Email (Resend) ====================
const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  if (!resend) {
    console.log(`[Email] RESEND_API_KEY not set. Code for ${email}: ${code}`);
    return true; // 개발 모드에서는 콘솔 출력
  }

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'HandsfreeClaw <noreply@resend.dev>',
      to: email,
      subject: 'HandsfreeClaw 인증 코드',
      html: `
        <h2>🎙️ HandsfreeClaw 인증 코드</h2>
        <p>아래 코드를 입력해주세요:</p>
        <h1 style="font-size: 32px; letter-spacing: 5px; color: #4a90d9;">${code}</h1>
        <p>이 코드는 10분 후 만료됩니다.</p>
      `,
    });
    console.log(`[Email] Sent verification code to ${email}`);
    return true;
  } catch (err) {
    console.error('[Email] Send failed:', err);
    return false;
  }
}

// ==================== Auth Helpers ====================
function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getOrCreateUser(email: string): { id: number; email: string } {
  const normalizedEmail = email.toLowerCase().trim();
  
  let user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(normalizedEmail) as any;
  
  if (!user) {
    const result = db.prepare('INSERT INTO users (email) VALUES (?)').run(normalizedEmail);
    user = { id: result.lastInsertRowid, email: normalizedEmail };
  }
  
  return user;
}

function createSession(userId: number): string {
  const token = `sess_${nanoid(32)}`;
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30일
  
  db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(userId, token, expiresAt.toISOString());
  
  return token;
}

function getUserFromSession(token: string): { id: number; email: string } | null {
  const session = db.prepare(`
    SELECT s.user_id, s.expires_at, u.email
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `).get(token) as any;

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return { id: session.user_id, email: session.email };
}

// Auth middleware
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const user = getUserFromSession(token);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  (req as any).user = user;
  next();
}

// ==================== Auth Routes ====================

// 인증 코드 요청
app.post('/api/auth/request-code', async (req, res) => {
  const { email } = req.body;
  
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10분

  db.prepare('INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)')
    .run(email.toLowerCase().trim(), code, expiresAt.toISOString());

  const sent = await sendVerificationEmail(email, code);
  
  if (!sent) {
    return res.status(500).json({ error: 'Failed to send email' });
  }

  res.json({ message: 'Verification code sent' });
});

// 인증 코드 검증
app.post('/api/auth/verify', (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  
  const verification = db.prepare(`
    SELECT id, expires_at FROM verification_codes 
    WHERE email = ? AND code = ? AND used = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(normalizedEmail, code) as any;

  if (!verification) {
    return res.status(400).json({ error: 'Invalid code' });
  }

  if (new Date(verification.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Code expired' });
  }

  // 코드 사용 처리
  db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(verification.id);

  // 사용자 생성/조회 및 세션 발급
  const user = getOrCreateUser(normalizedEmail);
  const sessionToken = createSession(user.id);

  res.json({
    token: sessionToken,
    user: { email: user.email },
  });
});

// 로그아웃
app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.slice(7);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ message: 'Logged out' });
});

// 현재 사용자 정보
app.get('/api/me', authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.json({ email: user.email });
});

// ==================== Pairing Routes ====================

// 내 페어링 목록
app.get('/api/pairings', authMiddleware, (req, res) => {
  const user = (req as any).user;
  
  const pairings = db.prepare(`
    SELECT id, gateway_token, name, created_at 
    FROM pairings WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(user.id);

  res.json(pairings);
});

// 페어링 등록 (Gateway에서 호출)
app.post('/api/pairings/register', async (req, res) => {
  const { email, gateway_token, name } = req.body;

  if (!email || !gateway_token) {
    return res.status(400).json({ error: 'Email and gateway_token required' });
  }

  const user = getOrCreateUser(email);

  // 이미 존재하는 토큰인지 확인
  const existing = db.prepare('SELECT id FROM pairings WHERE gateway_token = ?').get(gateway_token);
  
  if (existing) {
    // 업데이트
    db.prepare('UPDATE pairings SET user_id = ?, name = ? WHERE gateway_token = ?')
      .run(user.id, name || null, gateway_token);
  } else {
    // 새로 생성
    db.prepare('INSERT INTO pairings (user_id, gateway_token, name) VALUES (?, ?, ?)')
      .run(user.id, gateway_token, name || null);
  }

  console.log(`[Pairing] Registered ${gateway_token} for ${email}`);
  res.json({ message: 'Pairing registered' });
});

// 페어링 삭제
app.delete('/api/pairings/:id', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { id } = req.params;

  const result = db.prepare('DELETE FROM pairings WHERE id = ? AND user_id = ?')
    .run(id, user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Pairing not found' });
  }

  res.json({ message: 'Pairing deleted' });
});

// ==================== WebSocket (Live Connections) ====================

// 활성 연결 저장 (메모리)
interface LiveConnection {
  gatewayToken: string;
  appSocket?: WebSocket;
  gatewaySocket?: WebSocket;
}

const liveConnections = new Map<string, LiveConnection>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const clientType = url.searchParams.get('type'); // 'app' or 'gateway'
  const sessionToken = url.searchParams.get('session'); // 앱용 세션 토큰

  if (!token || !clientType) {
    ws.close(4000, 'Missing token or client type');
    return;
  }

  // 앱 연결 시 세션 검증
  if (clientType === 'app') {
    if (!sessionToken) {
      ws.close(4002, 'Session token required for app');
      return;
    }

    const user = getUserFromSession(sessionToken);
    if (!user) {
      ws.close(4003, 'Invalid session');
      return;
    }

    // 해당 사용자의 페어링인지 확인
    const pairing = db.prepare(`
      SELECT id FROM pairings WHERE gateway_token = ? AND user_id = ?
    `).get(token, user.id);

    if (!pairing) {
      ws.close(4004, 'Pairing not found for this user');
      return;
    }
  }

  // Gateway 연결 시 토큰이 등록되어 있는지 확인
  if (clientType === 'gateway') {
    const pairing = db.prepare('SELECT id FROM pairings WHERE gateway_token = ?').get(token);
    if (!pairing) {
      ws.close(4005, 'Pairing not registered');
      return;
    }
  }

  console.log(`[WS] ${clientType} connected with token: ${token}`);

  // 연결 관리
  let connection = liveConnections.get(token);
  if (!connection) {
    connection = { gatewayToken: token };
    liveConnections.set(token, connection);
  }

  if (clientType === 'app') {
    connection.appSocket = ws;
    if (connection.gatewaySocket?.readyState === WebSocket.OPEN) {
      connection.gatewaySocket.send(JSON.stringify({ type: 'app_connected' }));
      ws.send(JSON.stringify({ type: 'gateway_connected' }));
    }
  } else if (clientType === 'gateway') {
    connection.gatewaySocket = ws;
    if (connection.appSocket?.readyState === WebSocket.OPEN) {
      connection.appSocket.send(JSON.stringify({ type: 'gateway_connected' }));
      ws.send(JSON.stringify({ type: 'app_connected' }));
    }
  }

  // 메시지 릴레이
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const targetSocket = clientType === 'app' 
        ? connection!.gatewaySocket 
        : connection!.appSocket;

      if (targetSocket?.readyState === WebSocket.OPEN) {
        targetSocket.send(JSON.stringify(message));
      }
    } catch (err) {
      console.error('[WS] Message error:', err);
    }
  });

  // 연결 종료
  ws.on('close', () => {
    console.log(`[WS] ${clientType} disconnected: ${token}`);
    
    if (clientType === 'app') {
      connection!.appSocket = undefined;
      connection!.gatewaySocket?.send(JSON.stringify({ type: 'app_disconnected' }));
    } else {
      connection!.gatewaySocket = undefined;
      connection!.appSocket?.send(JSON.stringify({ type: 'gateway_disconnected' }));
    }
  });

  ws.send(JSON.stringify({ type: 'connected', clientType, token }));
});

// ==================== Health Check ====================
app.get('/health', (req, res) => {
  const stats = {
    status: 'ok',
    users: (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count,
    pairings: (db.prepare('SELECT COUNT(*) as count FROM pairings').get() as any).count,
    liveConnections: liveConnections.size,
  };
  res.json(stats);
});

// ==================== Start Server ====================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🎙️ HandsfreeClaw server running on port ${PORT}`);
});
