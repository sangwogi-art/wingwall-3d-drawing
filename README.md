# 2D 도면 기반 3D 수로암거 및 옹벽형 날개벽 모델링 웹 시스템 (Code/3d-drawing)

2D CAD 도면(일반도 및 구조도/배근도 DWG/DXF 5종)을 분석하여 수로암거(`STA.13+611.21`) 및 옹벽형 날개벽의 3D 솔리드 외형과 3D 내부 철근 배근(19종 508본)을 자동 구축하고, Three.js 기반의 웹 뷰어를 통해 인터랙티브하게 확인·검증·내보내기하는 시스템입니다.

---

## 1. 주요 특징 및 구현 내용

- **1단계: 도면 불러오기 및 도면 종류 판별**
  - DWG/DXF 파일 파싱 (`ezdwg`, `ezdxf`)
  - 도면명 키워드 자동 판별: `'일반'` ➔ 일반도, `'배근'`/`'구조'` ➔ 구조도/배근도
  - 2D CAD 벡터 뷰어 및 레이어 제어 지원
- **2단계: 일반도 기반 3D 외형 모델링**
  - 암거 본체 및 날개벽 위치 판별 (시점부 좌/우, 종점부 좌/우)
  - 본 도면 특성 완벽 준수: 시점부 미표기 ➔ 임의 생성 배제 / 종점부 좌·우 2개소 모델링 ($L=4.35\text{m}$, $L=5.40\text{m}$)
  - 완전 폐합 2-Manifold 수밀성(Watertight) 3D 솔리드 메시 생성 (총 콘크리트 체적: $75.45\text{ m}^3$)
- **3단계: 배근도 기반 3D 철근 배근 모델링**
  - 피복두께 80mm 준수
  - 19종 철근 기호, 총 508본 3D 입체 배근 (종점 좌 231본 + 종점 우 277본)
  - 철근 재료표(BBS) 자동 산출 (총중량: $1.543\text{ TON}$, 할증 포함 $1.590\text{ TON}$)
- **웹 3D 뷰어 (Three.js)**
  - 3차원 자유 시점 궤도 제어 (OrbitControls)
  - 암거 본체 / 날개벽 / 철근 레이어별 가시화 및 투명도 제어
  - 3D 모델 OBJ, STL, DXF 내보내기

---

## 2. 작업 환경 및 디렉터리 구성

- **작업 환경**: WSL2 (Ubuntu Linux)
- **저장소 위치**: `Code/3d-drawing/` (Git 관리)

```text
Code/3d-drawing/
├── cad_parser.py         # 2D DWG/DXF 도면 파싱 및 종류 판별
├── model_3d.py           # 3D 수로암거 및 날개벽 파라메트릭 솔리드 모델러
├── rebar_model.py        # 3D 철근 배근 생성기 (19종 기호, 508본)
├── exporters.py          # OBJ / STL / DXF 3D 파일 내보내기 모듈
├── bundle_data.py        # 도면 및 3D 데이터 번들링 유틸리티
├── app.py                # Flask 웹 REST API 서버
├── index.html            # Three.js 기반 3D CAD/BIM 웹 뷰어
├── static/               # CSS, JS(app.js, viewer3d.js), Three.js 라이브러리 및 데이터
├── run_wsl.sh            # WSL2 원클릭 실행 스크립트
├── test_pipeline.py      # 파이프라인 전수 자동화 검증 테스트
├── requirements.txt      # Python 패키지 의존성
└── README.md             # 본 설명서
```

---

## 3. WSL2 실행 방법

WSL2(Ubuntu) 터미널에서 아래 명령을 실행합니다:

```bash
cd Code/3d-drawing
chmod +x run_wsl.sh
./run_wsl.sh
```

실행 후 웹 브라우저에서 아래 주소로 접속합니다:
- **`http://localhost:5000`** 또는 **`http://127.0.0.1:5000`**

---

## 4. 자동 테스트 및 검증 실행

```bash
cd Code/3d-drawing
~/.venv-3d-drawing/bin/python test_pipeline.py
```
