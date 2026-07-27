<div align="center">

# OpenTakeoff

**사람과 AI 에이전트 모두를 위해 만들어진 최초의 물량 산출 캔버스.**

건축 도면을 열어 측정하세요 — 직접 실을 트레이스하거나, **동일한 엔진**에 AI 에이전트를 붙이거나.
모든 측정값이 그 **축척**과 **어떻게 측정되었는지**를 함께 지닙니다. 무료, 오픈소스,
브라우저에서 실행 — 계정 없음, 업로드 없음, 설치 없음.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/demo-opentakeoff.netlify.app-2ea44f.svg)](https://opentakeoff.netlify.app)
[![Built with React + Vite](https://img.shields.io/badge/React%2018-Vite-444.svg)](#기술-스택)

[**▶ 라이브 데모 실행**](https://opentakeoff.netlify.app) · [빠른 시작](#빠른-시작) · [기능](#주요-기능) · [AI 에이전트용](mcp/) · [English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh-Hans.md)

<br/>

<img src="docs/img/social-card.png" alt="OpenTakeoff — 바닥 마감 도면에서의 실제 물량 산출. 사람이든 MCP를 통한 AI 에이전트든 동일하게 조작하며, 각 측정의 축척과 출처가 기록된다" width="820"/>

</div>

---

OpenTakeoff는 건축 도면에서 수량을 측정하는 — **물량 산출**(takeoff) — 무료 오픈소스
캔버스입니다. 차이점은 "누가 실행할 수 있는가"입니다. 사람 **또는** AI 에이전트가 **동일한 엔진**을
구동합니다. 실 안쪽을 클릭하면 윤곽이 스스로 트레이스되고, 에이전트는 [MCP](mcp/)를 통해 같은
도구를 호출해 같은 값을 얻습니다. 그리고 모든 측정값이 **어떻게 만들어졌는지**를 기록합니다 —
축척, 원클릭인지 수작업인지, 사람이 그렸는지 에이전트가 그렸는지. 근거가 숫자와 함께 이동합니다.

지금까지 **웹 기반 오픈소스 물량 산출 캔버스는 존재하지 않았습니다** — 바닥 마감용은 말할 것도 없고요.
OpenTakeoff가 바로 그 도구입니다. 업계에 무상으로 제공되는 진짜 대안입니다.

원래는 상용 바닥 마감 적산 앱의 물량 산출 모듈이었습니다. 그것을 떼어내고, 정리하고, 공개한 것입니다.
**이것은 데모가 아니라 실제 측정 엔진입니다** — 월 $300짜리 도구들이 구독 뒤에 감춰둔
영역 채우기(flood-fill) 방식의 실 트레이서 **One-Click Area**를 포함합니다.

### 미터법을 지원합니다

한국 도면에서 그대로 사용할 수 있습니다. **m² / m 표기**와 **1:50, 1:100 형식의 축척**을
기본 지원하며, 축척은 **시트별로** 기억됩니다 (도면 세트의 축척이 전 장에 걸쳐 균일한 경우는
거의 없기 때문입니다). 야드·파운드법과의 전환도 가능합니다.

### 다만, 앱 UI는 현재 영어만 지원합니다

솔직히 말씀드립니다. 측정, 수치, 내보내기는 모두 언어와 무관하지만 툴바와 메뉴 라벨은
현재 영어뿐이며 UI 번역 레이어가 아직 없습니다. 도면을 읽고 물량을 뽑는 작업 자체는 문제없이
되지만 버튼 문구는 영어입니다. 한국어 UI가 필요하시면
[이슈로 알려주세요](https://github.com/Kentucky-ai/opentakeoff/issues) — 수요가 확인되면
착수합니다.

## 빠른 시작

쓰기만 할 거라면 설치할 것이 없습니다 — [**라이브 데모**](https://opentakeoff.netlify.app)를 열고
도면을 끌어다 놓으면 됩니다.

직접 실행하려면:

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

**`demo/sample-plan.pdf`** 를 캔버스에 끌어다 놓으세요. 축척은 자동 인식됩니다. 조건(condition)을
선택하고 **One-Click Area**를 누른 뒤 실 안쪽을 클릭하세요. **Report**를 열면 내역이 나오고
CSV / JSON으로 내보낼 수 있습니다.

## 주요 기능

| 영역 | 내용 |
|---|---|
| **불러오기** | PDF, 이미지, `.zip` 도면 세트 — 브라우저 내에서 압축 해제, 다중 페이지, 최대 4개 시트 나란히 보기 |
| **축척** | 도면에 기재된 축척을 자동 인식하거나, 알고 있는 치수로 보정 — 시트별로 유지 |
| **측정** | One-Click Area(영역 채우기), 면적, 사각형, 길이, 벽 면적, 개수, 공제(deduct), 구역별 집계 — 미터법 / 야드·파운드법 |
| **작도 보조** | 45°/90° 각도 고정(⇧로 강제 고정), 커서 옆에 각도와 선분 길이 실시간 표시, 끝점 스냅(beta) |
| **조건(condition)** | 마감별 색상 + CAD 해치 패턴, 할증률, ×N 배수, 벽 높이, 두께 → 걸레받이·띠장 면적 환산 |
| **부자재** | 시공 방법 및 바탕(하지) 종류, 그리고 접착제·실러·우레탄·몰탈·줄눈재 등 부자재를 도포량(피복률) 기준으로 소요 수량으로 자동 환산(올림 처리) |
| **리포트** | 조건별 바닥/벽/걸레받이 면적, 길이, 개수, 할증 포함·미포함 + 자재 발주 목록 |
| **내보내기** | CSV, JSON, **Excel(.xlsx)**, 인쇄, **마킹 세트 PDF**(도면 + 작업 내용 + 범례 표지를 브라우저에서 생성) |
| **개정 관리** | 입찰 개정 시마다 산출을 저장하고 차이를 비교 — 조건별·시트별·발주 목록별 수량 델타 |
| **마크업** | 구름 표시, 지시선, 텍스트 메모 — 별도 레이어이며 수량에 절대 포함되지 않음 |
| **보기** | 라이트 / **다크(네거티브 인쇄)** — CSS 필터가 아니라 도면 픽셀 자체를 그릴 때 반전 |
| **저장** | IndexedDB + localStorage — 완전한 클라이언트 측 저장, 업로드 없음 |
| **MCP 서버** | MCP 클라이언트에서 stdio로 엔진 구동 — 도면 로드, 축척 설정, 실 원클릭, 산출 결과 내보내기 ([`mcp/`](mcp/README.md)) |
| **출처 기록** | 모든 도형이 어떻게 측정되었는지 기록 — 축척, 원클릭인지 수작업인지, 사람인지 에이전트인지 |
| **배포** | 정적 빌드 하나. Netlify, Vercel, GitHub Pages, S3 등 모든 정적 호스트에서 동작 |

## AI 에이전트에서 사용하기

동일한 엔진이 [MCP](https://modelcontextprotocol.io)를 구사합니다. [`mcp/`](mcp/README.md)는
MCP 클라이언트가 구동할 수 있는 stdio 서버로, 명령 하나면 실행됩니다 — `npx -y opentakeoff-mcp`.
`load_plan`, `read_sheet_text`, `set_scale`, `one_click`, `view_sheet`, `takeoff_summary`,
`export_takeoff` 등을 제공합니다.

에이전트는 도면을 열고, 표제란을 읽고, 축척을 채택하고(조용히 적용되는 일은 없습니다), 실을
클릭하고, 보정된 측정 그리드가 있는 렌더링 이미지(`view_sheet`)로 자기 작업을 검증한 뒤,
앱이 자동 저장하는 것과 동일한 페이로드를 내보냅니다 — 같은 계산, 같은 출처 기록, 같은 축척 게이트.
설정 방법과 전체 대화 예시: [`docs/MCP.md`](docs/MCP.md)

## 데이터는 당신의 것입니다

도면, 축척, 조건, 마크업은 모두 **당신의 브라우저**에 자동 저장됩니다(IndexedDB + localStorage).
업로드가 없고, 계정이 없으며, 기본 빌드에는 서버가 존재하지 않습니다. 정적 빌드를 직접 호스팅하면
그 상태가 그대로 유지됩니다. 음성 입력을 쓰더라도 음성 인식은 브라우저 내 온디바이스로 처리되어
오디오가 기기 밖으로 나가지 않습니다.

## 그 뒤의 연구

OpenTakeoff는 자기 부서가 쓰는 AI를 직접 만드는 현직 상업 바닥 마감 적산 담당자가 운영하는
응용 연구 프로그램([Kentucky AI](https://kentucky-ai.com))의 "열린 절반"입니다. 그 경계는
의도적이며, 좋은 오픈코어 과학 소프트웨어가 긋는 것과 같은 선입니다 —
**측정 엔진(렌더링, 축척, 지오메트리, 내보내기, MCP 서버)은 Apache-2.0으로 계속 열려 있고,
자사 적산 아카이브로 학습시킨 AI 모델은 독점입니다.** 좌석 라이선스 없는 진짜 도구를 얻고,
우리는 우리 데이터로만 만들 수 있는 부분을 지킵니다.

공개된 연구 산출물(모델 카드, 벤치마크 명세, 논문):
[Hugging Face](https://huggingface.co/Kentucky-ai) · [kentucky-ai.com](https://kentucky-ai.com)

## 위에 얹어 만들기

OpenTakeoff는 **Apache-2.0**입니다. 포크하고, 고치고, 출시하세요 — 당신 팀을 위해서든,
당신 제품의 토대로든. 코드베이스는 의도적으로 작고 읽기 쉽게 유지됩니다:

- **지오메트리와 측정** — [`web/src/lib/oneclick.ts`](web/src/lib/oneclick.ts), [`web/src/lib/sheets.ts`](web/src/lib/sheets.ts) (타입 지정 + 테스트 완료)
- **집계와 자재 계산** — [`web/src/lib/totals.js`](web/src/lib/totals.js)
- **상태와 영속화** — [`web/src/lib/store.js`](web/src/lib/store.js)
- **UI** — [`web/src/pages/TakeoffCanvas.jsx`](web/src/pages/TakeoffCanvas.jsx), [`web/src/components/`](web/src/components/)

PR 전에 `npm run typecheck && npm test && npm run build`를 실행하세요. 지오메트리 라이브러리는
순수 함수 + 테스트 상태로 유지하고, 실제 프로젝트 도면은 절대 커밋하지 마세요.
[CONTRIBUTING.md](CONTRIBUTING.md)와 [사용자 가이드](docs/USER_GUIDE.md)를 참고하세요.

**기여를 환영합니다.** 이슈나 PR은 한국어로 작성하셔도 됩니다 — 저희가 번역해서 대응합니다.
[`good first issue`](https://github.com/Kentucky-ai/opentakeoff/labels/good%20first%20issue) 라벨이
붙은 이슈는 작고, 명세가 분명하며, 해당 파일까지 지목해 두었습니다. 테스트가 있고 CI가 초록인
PR은 빠르게 머지됩니다.

## 기술 스택

- **프론트엔드:** React 18 + Vite (순수 JSX)
- **드로잉:** 순수 HTML5 Canvas + SVG (드로잉 프레임워크 없음)
- **지오메트리:** TypeScript (`oneclick.ts`, `sheets.ts`)
- **PDF 렌더링:** [pdf.js](https://github.com/mozilla/pdf.js)
- **도면 세트 불러오기:** fflate(zip) + pdf-lib(이미지 → PDF), 지연 로드
- **저장:** IndexedDB + localStorage — 백엔드 불필요
- **테스트:** `node --test` + `tsx`
- **유료 의존성 없음.** [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 참고.

## 상태

OpenTakeoff는 미리보기가 아니라 **실제로 쓰이는 도구**입니다. 측정 엔진 — One-Click Area,
조건, 부자재, 리포트와 내보내기 — 은 상용 바닥 마감 적산 앱에서 떼어낸 프로덕션 엔진입니다.
**Snap**은 beta로 표시되어 있습니다. 실제 상업 바닥 마감 입찰에 사용되고 있습니다.

## 라이선스

[Apache License 2.0](LICENSE) — 쓰고, 포크하고, 출시하고, 그 위에 만드세요.
저작자 표시는 [NOTICE](NOTICE)를 참고하세요.

---

> **이 한국어판에 대하여.** 정본은 영어판 [README.md](README.md)입니다. 이 번역은 요약본이며
> 최신 기능이 반영되기까지 시차가 있을 수 있습니다. 내용이 다를 경우 영어판이 우선합니다.
> 전체 기능 목록은 [FEATURES.md](FEATURES.md), 변경 이력은 [CHANGELOG.md](CHANGELOG.md)를
> 참고하세요. 번역 오류를 발견하시면 이슈나 PR로 알려주시면 감사하겠습니다.
