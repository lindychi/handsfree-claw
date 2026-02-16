import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { createServer } from 'http';
import { nanoid } from 'nanoid';
import pg from 'pg';
import { Resend } from 'resend';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ==================== Database (PostgreSQL) ====================
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// 테이블 생성
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS verification_codes (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pairings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        gateway_token TEXT UNIQUE NOT NULL,
        name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_pairings_user ON pairings(user_id);
      CREATE INDEX IF NOT EXISTS idx_pairings_token ON pairings(gateway_token);
    `);
    console.log('[DB] Tables initialized');
  } finally {
    client.release();
  }
}

// ==================== Email (Resend) ====================
const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  if (!resend) {
    console.log(`[Email] RESEND_API_KEY not set. Code for ${email}: ${code}`);
    return true;
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

async function getOrCreateUser(email: string): Promise<{ id: number; email: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  
  // Try to find existing user
  let result = await pool.query('SELECT id, email FROM users WHERE email = $1', [normalizedEmail]);
  
  if (result.rows.length === 0) {
    // Create new user
    result = await pool.query(
      'INSERT INTO users (email) VALUES ($1) RETURNING id, email',
      [normalizedEmail]
    );
  }
  
  return result.rows[0];
}

async function createSession(userId: number): Promise<string> {
  const token = `sess_${nanoid(32)}`;
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30일
  
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
  
  return token;
}

async function getUserFromSession(token: string): Promise<{ id: number; email: string } | null> {
  const result = await pool.query(`
    SELECT s.user_id as id, s.expires_at, u.email
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = $1
  `, [token]);

  if (result.rows.length === 0) return null;
  
  const session = result.rows[0];
  if (new Date(session.expires_at) < new Date()) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }

  return { id: session.id, email: session.email };
}

// Auth middleware
async function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const user = await getUserFromSession(token);
  
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

  await pool.query(
    'INSERT INTO verification_codes (email, code, expires_at) VALUES ($1, $2, $3)',
    [email.toLowerCase().trim(), code, expiresAt]
  );

  const sent = await sendVerificationEmail(email, code);
  
  if (!sent) {
    return res.status(500).json({ error: 'Failed to send email' });
  }

  res.json({ message: 'Verification code sent' });
});

// 인증 코드 검증
app.post('/api/auth/verify', async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  
  const result = await pool.query(`
    SELECT id, expires_at FROM verification_codes 
    WHERE email = $1 AND code = $2 AND used = FALSE
    ORDER BY created_at DESC LIMIT 1
  `, [normalizedEmail, code]);

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Invalid code' });
  }

  const verification = result.rows[0];
  if (new Date(verification.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Code expired' });
  }

  // 코드 사용 처리
  await pool.query('UPDATE verification_codes SET used = TRUE WHERE id = $1', [verification.id]);

  // 사용자 생성/조회 및 세션 발급
  const user = await getOrCreateUser(normalizedEmail);
  const sessionToken = await createSession(user.id);

  res.json({
    token: sessionToken,
    user: { email: user.email },
  });
});

// 로그아웃
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ message: 'Logged out' });
});

// 현재 사용자 정보
app.get('/api/me', authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.json({ email: user.email });
});

// ==================== Pairing Routes ====================

// 내 페어링 목록
app.get('/api/pairings', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  
  const result = await pool.query(`
    SELECT id, gateway_token, name, created_at 
    FROM pairings WHERE user_id = $1
    ORDER BY created_at DESC
  `, [user.id]);

  res.json(result.rows);
});

// 페어링 등록 (Gateway에서 호출)
app.post('/api/pairings/register', async (req, res) => {
  const { email, gateway_token, name } = req.body;

  if (!email || !gateway_token) {
    return res.status(400).json({ error: 'Email and gateway_token required' });
  }

  const user = await getOrCreateUser(email);

  // 이미 존재하는 토큰인지 확인
  const existing = await pool.query('SELECT id FROM pairings WHERE gateway_token = $1', [gateway_token]);
  
  if (existing.rows.length > 0) {
    // 업데이트
    await pool.query(
      'UPDATE pairings SET user_id = $1, name = $2 WHERE gateway_token = $3',
      [user.id, name || null, gateway_token]
    );
  } else {
    // 새로 생성
    await pool.query(
      'INSERT INTO pairings (user_id, gateway_token, name) VALUES ($1, $2, $3)',
      [user.id, gateway_token, name || null]
    );
  }

  console.log(`[Pairing] Registered ${gateway_token} for ${email}`);
  res.json({ message: 'Pairing registered' });
});

// 페어링 삭제
app.delete('/api/pairings/:id', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { id } = req.params;

  const result = await pool.query(
    'DELETE FROM pairings WHERE id = $1 AND user_id = $2',
    [id, user.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Pairing not found' });
  }

  res.json({ message: 'Pairing deleted' });
});

// ==================== WebSocket (Live Connections) ====================

interface LiveConnection {
  gatewayToken: string;
  appSocket?: WebSocket;
  gatewaySocket?: WebSocket;
}

const liveConnections = new Map<string, LiveConnection>();

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const clientType = url.searchParams.get('type');
  const sessionToken = url.searchParams.get('session');

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

    const user = await getUserFromSession(sessionToken);
    if (!user) {
      ws.close(4003, 'Invalid session');
      return;
    }

    const pairing = await pool.query(
      'SELECT id FROM pairings WHERE gateway_token = $1 AND user_id = $2',
      [token, user.id]
    );

    if (pairing.rows.length === 0) {
      ws.close(4004, 'Pairing not found for this user');
      return;
    }
  }

  // Gateway 연결 시 토큰 확인
  if (clientType === 'gateway') {
    const pairing = await pool.query('SELECT id FROM pairings WHERE gateway_token = $1', [token]);
    if (pairing.rows.length === 0) {
      ws.close(4005, 'Pairing not registered');
      return;
    }
  }

  console.log(`[WS] ${clientType} connected with token: ${token}`);

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
app.get('/health', async (req, res) => {
  try {
    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const pairingsResult = await pool.query('SELECT COUNT(*) as count FROM pairings');
    
    res.json({
      status: 'ok',
      users: parseInt(usersResult.rows[0].count),
      pairings: parseInt(pairingsResult.rows[0].count),
      liveConnections: liveConnections.size,
    });
  } catch (err) {
    res.json({
      status: 'ok',
      db: 'initializing',
      liveConnections: liveConnections.size,
    });
  }
});

// ==================== Start Server ====================
const PORT = process.env.PORT || 8080;

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🎙️ HandsfreeClaw server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  // 서버는 시작하되 DB 없이
  server.listen(PORT, () => {
    console.log(`🎙️ HandsfreeClaw server running on port ${PORT} (DB unavailable)`);
  });
});
