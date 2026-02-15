# 🎙️ HandsfreeClaw

OpenClaw Gateway용 핸즈프리 음성 인터페이스 앱

## 개요

- **목표:** OpenClaw 사용자들에게 핸즈프리 음성 통신 제공
- **플랫폼:** iOS, Android, Web (Capacitor)
- **통신 방식:** 텔레그램 메시지 형태 (요청-응답)

## 아키텍처

```
[Voice App] → 네이티브 STT → 텍스트
                    ↓
            [OpenClaw Gateway]
                    ↓
            텍스트 → 네이티브 TTS → [Voice App]
```

## 기술 스택

- **Frontend:** React + TypeScript + Vite
- **Cross-platform:** Capacitor
- **STT:** @capacitor-community/speech-recognition
- **TTS:** @capacitor-community/text-to-speech

## 개발 환경 설정

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev

# 빌드
npm run build

# Capacitor sync
npx cap sync
```

## 모바일 빌드

### iOS
```bash
npx cap open ios
# Xcode에서 빌드 및 실행
```

### Android
```bash
npx cap open android
# Android Studio에서 빌드 및 실행
```

## 사용 방법

1. 앱 실행
2. Gateway URL과 API Token 입력
3. 마이크 버튼을 누르고 말하기
4. 버튼을 놓으면 Gateway로 전송
5. 응답이 TTS로 재생됨

## 프로젝트 구조

```
handsfree-claw/
├── src/
│   ├── App.tsx         # 메인 앱 컴포넌트
│   ├── App.css         # 스타일
│   └── main.tsx        # 진입점
├── ios/                # iOS 네이티브 프로젝트
├── android/            # Android 네이티브 프로젝트
├── capacitor.config.ts # Capacitor 설정
└── package.json
```

## TODO

### Phase 1 (MVP)
- [x] 프로젝트 셋업
- [x] 기본 UI
- [ ] Gateway API 연동 테스트
- [ ] iOS 빌드 테스트
- [ ] Android 빌드 테스트

### Phase 2 (개선)
- [ ] 서버 TTS (고품질 음성)
- [ ] 푸시 알림
- [ ] 다크/라이트 모드

### Phase 3 (배포)
- [ ] 앱스토어 배포
- [ ] 문서화

## 라이센스

MIT
