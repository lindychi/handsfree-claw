import { useState, useEffect, useRef } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'
import { TextToSpeech } from '@capacitor-community/text-to-speech'
import './App.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

function App() {
  const [isListening, setIsListening] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [isConfigured, setIsConfigured] = useState(false)
  const [status, setStatus] = useState('설정을 입력하세요')
  
  const configRef = useRef({ gatewayUrl: '', apiToken: '' })

  useEffect(() => {
    configRef.current = { gatewayUrl, apiToken }
  }, [gatewayUrl, apiToken])

  useEffect(() => {
    // 저장된 설정 로드
    const savedUrl = localStorage.getItem('gatewayUrl')
    const savedToken = localStorage.getItem('apiToken')
    if (savedUrl && savedToken) {
      setGatewayUrl(savedUrl)
      setApiToken(savedToken)
      setIsConfigured(true)
      setStatus('준비됨')
    }

    // 권한 요청
    requestPermissions()

    // 음성 인식 결과 리스너
    SpeechRecognition.addListener('partialResults', handleSpeechResult)

    return () => {
      SpeechRecognition.removeAllListeners()
    }
  }, [])

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

  const saveConfig = () => {
    if (gatewayUrl && apiToken) {
      localStorage.setItem('gatewayUrl', gatewayUrl)
      localStorage.setItem('apiToken', apiToken)
      setIsConfigured(true)
      setStatus('준비됨')
    }
  }

  const startListening = async () => {
    if (!isConfigured) {
      setStatus('먼저 Gateway 설정을 완료하세요')
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
    const { gatewayUrl: url, apiToken: token } = configRef.current
    
    if (!url || !token) {
      setStatus('Gateway 설정이 필요합니다')
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

    try {
      // Gateway API 호출
      const response = await fetch(`${url}/api/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          text: text,
          channel: 'voice',
          session: 'handsfree-claw'
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      const assistantText = data.text || data.message || '응답을 받지 못했습니다'

      // 어시스턴트 메시지 추가
      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantText,
        timestamp: new Date()
      }
      setMessages(prev => [...prev, assistantMessage])
      setStatus('재생 중...')

      // TTS로 읽기
      await TextToSpeech.speak({
        text: assistantText,
        lang: 'ko-KR',
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
      })

      setStatus('준비됨')

    } catch (error) {
      console.error('API 호출 실패:', error)
      setStatus(`오류: ${error}`)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>🎙️ HandsfreeClaw</h1>
        <p className="status">{status}</p>
      </header>

      {!isConfigured ? (
        <div className="config">
          <h2>Gateway 설정</h2>
          <input
            type="url"
            placeholder="Gateway URL (https://...)"
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
          />
          <input
            type="password"
            placeholder="API Token"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
          />
          <button onClick={saveConfig}>저장</button>
        </div>
      ) : (
        <>
          <div className="messages">
            {messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}`}>
                <span className="role">{msg.role === 'user' ? '🗣️' : '🤖'}</span>
                <p>{msg.content}</p>
              </div>
            ))}
          </div>

          <div className="controls">
            <button
              className={`mic-button ${isListening ? 'listening' : ''}`}
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onTouchStart={startListening}
              onTouchEnd={stopListening}
            >
              {isListening ? '🔴' : '🎤'}
            </button>
            <p className="hint">
              {isListening ? '버튼을 놓으면 전송' : '버튼을 누르고 말하세요'}
            </p>
          </div>

          <button 
            className="reset-button"
            onClick={() => {
              setIsConfigured(false)
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
