import { useState, useEffect, useRef } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'
import { TextToSpeech } from '@capacitor-community/text-to-speech'
import './App.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface Pairing {
  id: number
  gateway_token: string
  name: string | null
  created_at: string
}

const SERVER_URL = 'wss://handsfree-claw-production.up.railway.app'
const API_URL = 'https://handsfree-claw-production.up.railway.app'

type Screen = 'login' | 'verify' | 'pairings' | 'chat'

function App() {
  // Auth state
  const [screen, setScreen] = useState<Screen>('login')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Pairing state
  const [pairings, setPairings] = useState<Pairing[]>([])
  const [selectedPairing, setSelectedPairing] = useState<Pairing | null>(null)

  // Chat state
  const [isListening, setIsListening] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [gatewayConnected, setGatewayConnected] = useState(false)
  const [status, setStatus] = useState('')

  const wsRef = useRef<WebSocket | null>(null)

  // 앱 시작 시 저장된 세션 확인
  useEffect(() => {
    const savedToken = localStorage.getItem('sessionToken')
    if (savedToken) {
      setSessionToken(savedToken)
      checkSession(savedToken)
    }

    requestPermissions()
    SpeechRecognition.addListener('partialResults', handleSpeechResult)

    return () => {
      SpeechRecognition.removeAllListeners()
      wsRef.current?.close()
    }
  }, [])

  // 세션 유효성 확인
  const checkSession = async (token: string) => {
    try {
      const res = await fetch(`${API_URL}/api/me`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        setSessionToken(token)
        setScreen('pairings')
        loadPairings(token)
      } else {
        localStorage.removeItem('sessionToken')
        setScreen('login')
      }
    } catch {
      setScreen('login')
    }
  }

  // 페어링 목록 로드
  const loadPairings = async (token: string) => {
    try {
      const res = await fetch(`${API_URL}/api/pairings`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        const data = await res.json()
        setPairings(data)
      }
    } catch (err) {
      console.error('Failed to load pairings:', err)
    }
  }

  // 인증 코드 요청
  const requestCode = async () => {
    if (!email.includes('@')) {
      setError('유효한 이메일을 입력하세요')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${API_URL}/api/auth/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })

      const data = await res.json()
      if (res.ok) {
        setScreen('verify')
        // DEV mode: auto-fill code if returned by server
        if (data.code) {
          setCode(data.code)
        }
      } else {
        setError(data.error || '코드 전송 실패')
      }
    } catch {
      setError('서버 연결 실패')
    } finally {
      setLoading(false)
    }
  }

  // 인증 코드 검증
  const verifyCode = async () => {
    if (code.length !== 6) {
      setError('6자리 코드를 입력하세요')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${API_URL}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      })

      if (res.ok) {
        const data = await res.json()
        setSessionToken(data.token)
        localStorage.setItem('sessionToken', data.token)
        setScreen('pairings')
        loadPairings(data.token)
      } else {
        const data = await res.json()
        setError(data.error || '인증 실패')
      }
    } catch {
      setError('서버 연결 실패')
    } finally {
      setLoading(false)
    }
  }

  // 로그아웃
  const logout = async () => {
    try {
      await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
    } catch {}
    
    wsRef.current?.close()
    localStorage.removeItem('sessionToken')
    setSessionToken('')
    setSelectedPairing(null)
    setScreen('login')
  }

  // 페어링 선택 및 연결
  const selectPairing = (pairing: Pairing) => {
    setSelectedPairing(pairing)
    setScreen('chat')
    connectWebSocket(pairing.gateway_token)
  }

  // WebSocket 연결
  const connectWebSocket = (gatewayToken: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const url = `${SERVER_URL}?token=${gatewayToken}&type=app&session=${sessionToken}`
    
    setStatus('서버 연결 중...')
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      setStatus('서버 연결됨, Gateway 대기 중...')
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'gateway_connected':
            setGatewayConnected(true)
            setStatus('준비됨 ✓')
            break
          case 'gateway_disconnected':
            setGatewayConnected(false)
            setStatus('Gateway 연결 끊김')
            break
          case 'message':
            handleAssistantMessage(data.text || data.content)
            break
          case 'error':
            setStatus(`오류: ${data.error}`)
            break
        }
      } catch (err) {
        console.error('Message parse error:', err)
      }
    }

    ws.onclose = () => {
      setIsConnected(false)
      setGatewayConnected(false)
      setStatus('연결 끊김')
      
      // 자동 재연결
      setTimeout(() => {
        if (selectedPairing && screen === 'chat') {
          connectWebSocket(gatewayToken)
        }
      }, 5000)
    }

    ws.onerror = () => setStatus('연결 오류')
  }

  // 권한 요청
  const requestPermissions = async () => {
    try {
      await SpeechRecognition.requestPermissions()
    } catch (error) {
      console.error('권한 요청 실패:', error)
    }
  }

  // TTS 재생
  const handleAssistantMessage = async (text: string) => {
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: text,
      timestamp: new Date()
    }])
    setStatus('재생 중...')

    try {
      await TextToSpeech.speak({
        text,
        lang: 'ko-KR',
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
      })
    } catch (err) {
      console.error('TTS error:', err)
    }
    
    setStatus('준비됨 ✓')
  }

  // STT 결과 처리
  const handleSpeechResult = async (data: { matches: string[] }) => {
    if (data.matches?.length > 0) {
      await sendMessage(data.matches[0])
    }
  }

  // 음성 인식 시작
  const startListening = async () => {
    if (!gatewayConnected) return

    try {
      setIsListening(true)
      setStatus('듣는 중...')
      await SpeechRecognition.start({
        language: 'ko-KR',
        maxResults: 1,
        partialResults: false,
        popup: false,
      })
    } catch (error) {
      setStatus('음성 인식 실패')
      setIsListening(false)
    }
  }

  // 음성 인식 중지
  const stopListening = async () => {
    try {
      await SpeechRecognition.stop()
    } catch {}
    setIsListening(false)
  }

  // 메시지 전송
  const sendMessage = async (text: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return

    setMessages(prev => [...prev, {
      role: 'user',
      content: text,
      timestamp: new Date()
    }])
    setStatus('전송 중...')

    wsRef.current.send(JSON.stringify({ type: 'message', text }))
  }

  // 페어링 삭제
  const deletePairing = async (id: number) => {
    if (!confirm('이 연결을 삭제하시겠습니까?')) return

    try {
      await fetch(`${API_URL}/api/pairings/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionToken}` }
      })
      loadPairings(sessionToken)
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  // ==================== Render ====================
  return (
    <div className="app">
      <header className="header">
        <h1>🎙️ HandsfreeClaw</h1>
        {screen !== 'login' && screen !== 'verify' && (
          <button onClick={logout} className="logout-btn">로그아웃</button>
        )}
      </header>

      {/* 로그인 화면 */}
      {screen === 'login' && (
        <div className="config">
          <h2>로그인</h2>
          <p className="description">이메일로 인증 코드를 받으세요</p>

          <input
            type="email"
            placeholder="이메일 주소"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && requestCode()}
          />

          {error && <p className="error">{error}</p>}

          <button 
            onClick={requestCode} 
            className="primary large"
            disabled={loading}
          >
            {loading ? '전송 중...' : '인증 코드 받기'}
          </button>
        </div>
      )}

      {/* 코드 입력 화면 */}
      {screen === 'verify' && (
        <div className="config">
          <h2>인증 코드 입력</h2>
          <p className="description">{email}로 전송된 6자리 코드를 입력하세요</p>

          <input
            type="text"
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && verifyCode()}
            className="code-input"
            maxLength={6}
          />

          {error && <p className="error">{error}</p>}

          <button 
            onClick={verifyCode} 
            className="primary"
            disabled={loading || code.length !== 6}
          >
            {loading ? '확인 중...' : '확인'}
          </button>

          <button onClick={() => setScreen('login')} className="secondary">
            다른 이메일 사용
          </button>
        </div>
      )}

      {/* 페어링 목록 화면 */}
      {screen === 'pairings' && (
        <div className="pairings-screen">
          <h2>내 연결</h2>
          
          {pairings.length === 0 ? (
            <div className="empty-pairings">
              <p>등록된 연결이 없습니다</p>
              <p className="hint">OpenClaw Gateway 설정에서 이메일로 연결을 등록하세요</p>
            </div>
          ) : (
            <div className="pairings-list">
              {pairings.map((p) => (
                <div key={p.id} className="pairing-item">
                  <div className="pairing-info" onClick={() => selectPairing(p)}>
                    <span className="pairing-name">{p.name || 'My Gateway'}</span>
                    <span className="pairing-date">
                      {new Date(p.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button 
                    onClick={() => deletePairing(p.id)} 
                    className="delete-btn"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}

          <button onClick={() => loadPairings(sessionToken)} className="secondary">
            새로고침
          </button>
        </div>
      )}

      {/* 채팅 화면 */}
      {screen === 'chat' && (
        <>
          <div className="chat-header">
            <button onClick={() => {
              wsRef.current?.close()
              setSelectedPairing(null)
              setIsConnected(false)
              setGatewayConnected(false)
              setMessages([])
              setScreen('pairings')
            }} className="back-btn">
              ← 뒤로
            </button>
            <span className="connection-name">{selectedPairing?.name || 'My Gateway'}</span>
            <span className="status-text">{status}</span>
          </div>

          <div className="connection-info">
            <span className={isConnected ? 'on' : 'off'}>
              서버 {isConnected ? '✓' : '✗'}
            </span>
            <span className={gatewayConnected ? 'on' : 'off'}>
              Gateway {gatewayConnected ? '✓' : '✗'}
            </span>
          </div>

          <div className="messages">
            {messages.length === 0 && (
              <p className="empty">마이크 버튼을 눌러 대화를 시작하세요</p>
            )}
            {messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}`}>
                <span className="role">{msg.role === 'user' ? '🗣️' : '🤖'}</span>
                <p>{msg.content}</p>
              </div>
            ))}
          </div>

          <div className="controls">
            <button
              className={`mic-button ${isListening ? 'listening' : ''} ${!gatewayConnected ? 'disabled' : ''}`}
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onTouchStart={startListening}
              onTouchEnd={stopListening}
              disabled={!gatewayConnected}
            >
              {isListening ? '🔴' : '🎤'}
            </button>
            <p className="hint">
              {!gatewayConnected 
                ? 'Gateway 연결 대기 중...' 
                : isListening 
                  ? '버튼을 놓으면 전송' 
                  : '버튼을 누르고 말하세요'}
            </p>
          </div>
        </>
      )}
    </div>
  )
}

export default App
