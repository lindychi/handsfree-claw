import { useState, useEffect, useRef } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'
import { TextToSpeech } from '@capacitor-community/text-to-speech'
import './App.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

const DEFAULT_SERVER = 'wss://handsfree-claw.fly.dev' // 배포 후 변경

function App() {
  const [isListening, setIsListening] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [serverUrl, setServerUrl] = useState('')
  const [pairingToken, setPairingToken] = useState('')
  const [isConfigured, setIsConfigured] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [gatewayConnected, setGatewayConnected] = useState(false)
  const [status, setStatus] = useState('설정을 입력하세요')
  
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    // 저장된 설정 로드
    const savedUrl = localStorage.getItem('serverUrl') || DEFAULT_SERVER
    const savedToken = localStorage.getItem('pairingToken')
    
    setServerUrl(savedUrl)
    if (savedToken) {
      setPairingToken(savedToken)
      setIsConfigured(true)
    }

    // 권한 요청
    requestPermissions()

    // 음성 인식 결과 리스너
    SpeechRecognition.addListener('partialResults', handleSpeechResult)

    return () => {
      SpeechRecognition.removeAllListeners()
      wsRef.current?.close()
    }
  }, [])

  // 설정 완료 시 WebSocket 연결
  useEffect(() => {
    if (isConfigured && pairingToken) {
      connectWebSocket()
    }
  }, [isConfigured, pairingToken])

  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const wsUrl = serverUrl.replace('https://', 'wss://').replace('http://', 'ws://')
    const url = `${wsUrl}?token=${pairingToken}&type=app`
    
    setStatus('서버 연결 중...')
    console.log('Connecting to:', url)

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected')
      setIsConnected(true)
      setStatus('서버 연결됨, Gateway 대기 중...')
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('WS message:', data)

        switch (data.type) {
          case 'connected':
            setStatus('서버 연결됨')
            break
          case 'gateway_connected':
            setGatewayConnected(true)
            setStatus('준비됨 ✓')
            break
          case 'gateway_disconnected':
            setGatewayConnected(false)
            setStatus('Gateway 연결 끊김')
            break
          case 'message':
            // Gateway에서 온 응답
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
      console.log('WebSocket closed')
      setIsConnected(false)
      setGatewayConnected(false)
      setStatus('연결 끊김')
      
      // 자동 재연결 (5초 후)
      setTimeout(() => {
        if (isConfigured) connectWebSocket()
      }, 5000)
    }

    ws.onerror = (err) => {
      console.error('WebSocket error:', err)
      setStatus('연결 오류')
    }
  }

  const handleAssistantMessage = async (text: string) => {
    const assistantMessage: Message = {
      role: 'assistant',
      content: text,
      timestamp: new Date()
    }
    setMessages(prev => [...prev, assistantMessage])
    setStatus('재생 중...')

    // TTS로 읽기
    try {
      await TextToSpeech.speak({
        text: text,
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

  const handleSpeechResult = async (data: { matches: string[] }) => {
    if (data.matches && data.matches.length > 0) {
      const transcript = data.matches[0]
      await sendMessage(transcript)
    }
  }

  const requestPermissions = async () => {
    try {
      const { speechRecognition } = await SpeechRecognition.requestPermissions()
      if (speechRecognition !== 'granted') {
        setStatus('마이크 권한이 필요합니다')
      }
    } catch (error) {
      console.error('권한 요청 실패:', error)
    }
  }

  const createPairing = async () => {
    try {
      setStatus('페어링 생성 중...')
      const httpUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://')
      const response = await fetch(`${httpUrl}/api/pairing/create`, {
        method: 'POST'
      })
      const data = await response.json()
      setPairingToken(data.token)
      setStatus('페어링 토큰 생성됨!')
    } catch (err) {
      setStatus('페어링 생성 실패')
      console.error(err)
    }
  }

  const saveConfig = () => {
    if (serverUrl && pairingToken) {
      localStorage.setItem('serverUrl', serverUrl)
      localStorage.setItem('pairingToken', pairingToken)
      setIsConfigured(true)
    }
  }

  const startListening = async () => {
    if (!gatewayConnected) {
      setStatus('Gateway가 연결되지 않았습니다')
      return
    }

    try {
      setIsListening(true)
      setStatus('듣는 중...')

      await SpeechRecognition.start({
        language: 'ko-KR',
        maxResults: 1,
        prompt: '말씀하세요...',
        partialResults: false,
        popup: false,
      })
    } catch (error) {
      console.error('STT 시작 실패:', error)
      setStatus('음성 인식 실패')
      setIsListening(false)
    }
  }

  const stopListening = async () => {
    try {
      await SpeechRecognition.stop()
      setIsListening(false)
    } catch (error) {
      console.error('STT 중지 실패:', error)
      setIsListening(false)
    }
  }

  const sendMessage = async (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus('서버에 연결되지 않음')
      return
    }

    // 사용자 메시지 추가
    const userMessage: Message = {
      role: 'user',
      content: text,
      timestamp: new Date()
    }
    setMessages(prev => [...prev, userMessage])
    setStatus('전송 중...')

    // 서버로 전송 (Gateway로 릴레이됨)
    wsRef.current.send(JSON.stringify({
      type: 'message',
      text: text,
    }))
  }

  return (
    <div className="app">
      <header className="header">
        <h1>🎙️ HandsfreeClaw</h1>
        <p className="status">
          {status}
          {isConnected && <span className="dot connected" />}
          {gatewayConnected && <span className="dot gateway" />}
        </p>
      </header>

      {!isConfigured ? (
        <div className="config">
          <h2>연결 설정</h2>
          
          <input
            type="url"
            placeholder="서버 URL"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
          
          <div className="token-row">
            <input
              type="text"
              placeholder="페어링 토큰 (hfc_...)"
              value={pairingToken}
              onChange={(e) => setPairingToken(e.target.value)}
            />
            <button onClick={createPairing} className="small">생성</button>
          </div>

          {pairingToken && (
            <div className="token-display">
              <p>📋 Gateway 설정에 이 토큰을 입력하세요:</p>
              <code>{pairingToken}</code>
            </div>
          )}

          <button onClick={saveConfig} disabled={!pairingToken}>
            연결하기
          </button>
        </div>
      ) : (
        <>
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

          <button 
            className="reset-button"
            onClick={() => {
              wsRef.current?.close()
              setIsConfigured(false)
              setIsConnected(false)
              setGatewayConnected(false)
              localStorage.clear()
            }}
          >
            설정 초기화
          </button>
        </>
      )}
    </div>
  )
}

export default App
