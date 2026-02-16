import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { createServer } from 'http';
import { nanoid } from 'nanoid';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

// 페어링 저장소 (실제로는 DB 사용)
interface Pairing {
  token: string;
  createdAt: Date;
  appSocket?: WebSocket;
  gatewaySocket?: WebSocket;
}

const pairings = new Map<string, Pairing>();

// 페어링 토큰 생성
app.post('/api/pairing/create', (req, res) => {
  const token = `hfc_${nanoid(16)}`;
  pairings.set(token, {
    token,
    createdAt: new Date(),
  });
  console.log(`[Pairing] Created: ${token}`);
  res.json({ token });
});

// 페어링 상태 확인
app.get('/api/pairing/:token/status', (req, res) => {
  const { token } = req.params;
  const pairing = pairings.get(token);
  
  if (!pairing) {
    return res.status(404).json({ error: 'Token not found' });
  }

  res.json({
    token,
    appConnected: !!pairing.appSocket,
    gatewayConnected: !!pairing.gatewaySocket,
  });
});

// WebSocket 연결 처리
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const clientType = url.searchParams.get('type'); // 'app' or 'gateway'

  if (!token || !clientType) {
    console.log('[WS] Missing token or type');
    ws.close(4000, 'Missing token or client type');
    return;
  }

  const pairing = pairings.get(token);
  if (!pairing) {
    console.log(`[WS] Invalid token: ${token}`);
    ws.close(4001, 'Invalid token');
    return;
  }

  console.log(`[WS] ${clientType} connected with token: ${token}`);

  // 클라이언트 타입에 따라 소켓 저장
  if (clientType === 'app') {
    pairing.appSocket = ws;
    // Gateway에게 앱 연결 알림
    if (pairing.gatewaySocket?.readyState === WebSocket.OPEN) {
      pairing.gatewaySocket.send(JSON.stringify({
        type: 'app_connected',
      }));
    }
  } else if (clientType === 'gateway') {
    pairing.gatewaySocket = ws;
    // 앱에게 Gateway 연결 알림
    if (pairing.appSocket?.readyState === WebSocket.OPEN) {
      pairing.appSocket.send(JSON.stringify({
        type: 'gateway_connected',
      }));
    }
  }

  // 메시지 릴레이
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WS] Message from ${clientType}:`, message.type);

      // 상대방에게 릴레이
      const targetSocket = clientType === 'app' 
        ? pairing.gatewaySocket 
        : pairing.appSocket;

      if (targetSocket?.readyState === WebSocket.OPEN) {
        targetSocket.send(JSON.stringify(message));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Peer not connected',
        }));
      }
    } catch (err) {
      console.error('[WS] Message parse error:', err);
    }
  });

  // 연결 종료 처리
  ws.on('close', () => {
    console.log(`[WS] ${clientType} disconnected: ${token}`);
    
    if (clientType === 'app') {
      pairing.appSocket = undefined;
      if (pairing.gatewaySocket?.readyState === WebSocket.OPEN) {
        pairing.gatewaySocket.send(JSON.stringify({
          type: 'app_disconnected',
        }));
      }
    } else if (clientType === 'gateway') {
      pairing.gatewaySocket = undefined;
      if (pairing.appSocket?.readyState === WebSocket.OPEN) {
        pairing.appSocket.send(JSON.stringify({
          type: 'gateway_disconnected',
        }));
      }
    }
  });

  // 연결 성공 응답
  ws.send(JSON.stringify({
    type: 'connected',
    clientType,
    token,
  }));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', pairings: pairings.size });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🎙️ HandsfreeClaw server running on port ${PORT}`);
});
