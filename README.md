# YouTube Transcript to Docs

YouTube 영상의 자막을 Google Docs에 저장하는 Chrome 확장 프로그램입니다.
Gemini AI를 활용한 영상 요약 및 썸네일 설명 기능도 제공합니다.

## 주요 기능

- YouTube 영상 자막(스크립트) 추출
- Google Docs에 영상 정보 + 자막 자동 저장
- 타임라인 포함 옵션
- Gemini AI 요약 및 썸네일 설명 (선택)
- 저장 기록 관리

---

## 설치 방법

### Prerequisites

- Chrome 114 이상
- Google Cloud Console 계정
- (선택) Google AI Studio 계정 (Gemini 기능 사용 시)

### Step 1: Google Cloud Console 설정

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. **API 및 서비스 > 라이브러리**에서 다음 API 활성화:
   - **Google Docs API**
   - **YouTube Data API v3**
3. **API 및 서비스 > 사용자 인증 정보** > **사용자 인증 정보 만들기** > **OAuth 2.0 클라이언트 ID**
4. 애플리케이션 유형: **Chrome 앱** 선택
5. 생성된 **클라이언트 ID** 복사

### Step 2: manifest.json에 Client ID 설정

`manifest.json`의 `oauth2.client_id` 값을 복사한 Client ID로 교체합니다:

```json
"oauth2": {
  "client_id": "여기에_클라이언트_ID를_입력하세요.apps.googleusercontent.com",
  ...
}
```

### Step 3: Chrome 확장 프로그램 로드

1. Chrome 주소창에 `chrome://extensions` 입력
2. 우측 상단 **개발자 모드** 활성화
3. **압축 해제된 확장 프로그램 로드** 클릭
4. 이 프로젝트 폴더(`youtube-transcript-extension`) 선택

### Step 4: Google Docs 문서 ID 확인

저장할 Google Docs 문서의 URL에서 ID를 복사합니다:

```
https://docs.google.com/document/d/[이 부분이 문서 ID]/edit
```

### Step 5: 확장 프로그램 설정

1. YouTube에서 확장 프로그램 아이콘 클릭 → 사이드패널 열기
2. **설정** 탭 이동
3. **로그인** 버튼 클릭 → Google 계정 인증
4. **문서 ID** 입력 후 저장

### Step 6: Gemini API 키 설정 (선택)

AI 요약 및 썸네일 설명 기능을 사용하려면:

1. [Google AI Studio](https://aistudio.google.com/)에서 API 키 발급
2. **설정** 탭의 **Gemini API 키** 항목에 입력 후 저장

---

## 사용 방법

1. YouTube 영상 페이지(`youtube.com/watch?v=...`)로 이동
2. 사이드패널의 **저장** 탭에서 영상 정보 확인
3. 원하는 옵션 설정:
   - **타임라인 포함**: 자막에 `[MM:SS]` 타임스탬프 추가
   - **AI 요약**: Gemini로 영상 내용 요약 (Gemini API 키 필요)
   - **언어**: 요약 언어 선택
4. **저장하기** 버튼 클릭
5. Google Docs에 영상 정보가 추가됩니다

---

## 파일 구조

```
youtube-transcript-extension/
├── manifest.json              # 확장 프로그램 설정
├── background/
│   └── service-worker.js      # 메시지 라우팅 + 저장 파이프라인
├── content/
│   └── youtube.js             # YouTube 페이지 자막/영상 정보 추출
├── lib/
│   ├── youtube-api.js         # YouTube API (자막, 메타데이터)
│   ├── docs-api.js            # Google Docs API (저장)
│   └── gemini-api.js          # Gemini AI (요약, 썸네일 설명)
├── sidepanel/
│   ├── index.html             # 사이드패널 UI
│   ├── panel.js               # 사이드패널 로직
│   └── panel.css              # 스타일
├── icons/                     # 확장 프로그램 아이콘
└── README.md
```

---

## 문제 해결

**자막 없음 오류**: 해당 영상에 자막이 없거나 비활성화되어 있습니다.
**로그인 필요**: 설정 탭에서 Google 계정으로 로그인해주세요.
**저장 실패**: 문서 ID가 올바른지, 해당 문서에 편집 권한이 있는지 확인하세요.
