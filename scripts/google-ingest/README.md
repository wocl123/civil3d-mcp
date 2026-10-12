# 관리자 자동 수신 설정

사용자는 설치 EXE 실행 외에 Google 로그인, Drive 앱 설치, 경로 지정, 공유를 하지 않습니다.
새 EXE의 team.json에 담긴 ingestUrl로 최초 Civil 3D 실행 시 자동 등록하고 비식별 기록을 보냅니다.
설치·업데이트는 공개 GitHub Release를 사용하며 수신 웹앱은 관리자 계정의 비공개 MyCivil3DMcp-data에 저장합니다. 기존 MC 공유폴더는 새 배포에 사용하지 않습니다.

## 관리자 최초 한 번

1. 저장소에서 `node scripts/build-ingest.mjs`로 Validation.gs를 생성합니다.
2. wocl123@gmail.com으로 https://script.google.com 에서 새 프로젝트를 만듭니다.
3. 이 폴더의 Code.gs와 Validation.gs를 각각 같은 이름의 스크립트 파일로 넣습니다.
4. 프로젝트 설정에서 appsscript.json 표시를 켜고 이 폴더의 appsscript.json 내용을 넣습니다.
5. 왼쪽 **편집기(<> 아이콘)**를 누르고 `Code.gs`를 엽니다. `Ctrl+S`로 저장한 뒤,
   상단 **실행·디버그 옆 함수 선택 목록**에서 `setupIntake`를 선택하고 **실행**을 누릅니다.
   Google 권한 요청에서 관리자 계정을 선택하고 Drive 권한을 승인합니다.
   내 드라이브 바로 아래 비공개 MyCivil3DMcp-data를 생성합니다. MC 안에 만들지 않습니다.
   이미 설정한 경우 동일한 폴더를 유지합니다.
6. 배포 → 새 배포 → 웹 앱. **실행: 나**, **액세스: 모든 사용자(로그인 없는 사용자 포함)**로 배포합니다.
   `/dev` 대신 `/exec`로 끝나는 배포 URL을 복사합니다.
7. 관리자 PC Drive에 MyCivil3DMcp-data가 나타난 뒤 아래를 실행합니다.

```powershell
node scripts/ingest-config.mjs --configure "https://script.google.com/macros/s/배포ID/exec"
```

다른 Drive 경로를 사용하면 마지막 인수에 비공개 수집폴더 로컬 경로를 추가합니다.
준비 검사가 통과해야 .drive-deploy.json에 ingestUrl과 collectionRoot가 저장됩니다.
수신 URL은 비밀이 아니며 Google 계정 토큰/비밀번호는 설치 EXE에 넣지 않습니다.

8. `배포하기.bat -Version 0.1.6`로 새 EXE를 만듭니다. 이전 0.1.3 EXE에는 수신 URL이 없습니다.
9. `관리자실행.bat`으로 자동 수신된 사용자별 폴더를 가져오고 검토합니다.

관리자 설정 단계의 Google 권한 승인과 웹앱 배포는 Google 계정 소유자가 해야 합니다.
현재 코드를 추가하는 것만으로 웹앱이 실제 배포되거나 기존 설치가 바뀌지는 않습니다.

## 보안 보완을 기존 배포에 반영

2026-10-08 보안 점검 후 `Code.gs`와 `Validation.gs`가 변경됐습니다. 두 파일의 최신 내용을 편집기에 다시 넣고 저장하세요.
`auditIntakePermissions` 함수를 실행해 `safe: true`, `unsafe: []`, `truncated: false`를 확인합니다.
그다음 **배포 → 배포 관리 → 기존 웹 앱 수정(연필) → 버전: 새 버전 → 배포**로 반영하면 URL이 유지됩니다.
기존 수집폴더나 전송 키를 삭제하지 마세요. 상세 점검 결과는 `docs/Drive_보안점검.md`에 있습니다.

## 처리 방식

- 설치마다 무작위 설치ID와 전송용 키를 자동 생성합니다. 사용자 설정은 없습니다.
- 키 원문은 사용자 PC에만 저장하고 웹앱은 SHA-256 해시만 보관합니다.
- 수신 폴더에는 `MyCivil3DMcp-설치ID/member.json`, `packages`, `candidates`, `admin`이 있습니다.
- 묶음은 서버의 실제 비식별 검증기를 사용해 검사하고 모르는 항목을 제거합니다.
- 묶음 ID와 내용 해시를 확인한 수신 응답만 인정합니다. 확인이 실패하면 로컬 파일을 남깁니다.
- 같은 묶음 재전송은 중복 저장하지 않습니다. 같은 ID에 다른 내용은 거절합니다.
- 승인 지식은 사용자의 전송 키로 인증한 POST 응답에서 받아 적용합니다.
- 웹 GET은 준비 상태만 반환합니다. 다른 사용자 기록과 키를 조회하는 API는 없습니다.
- 이전 Drive 폴더 방식은 구버전 호환을 위해 남습니다. 새 EXE는 웹앱 전송을 우선합니다.
- 기존에 Drive 폴더로 보낸 기록은 새 수집함으로 자동 복사하지 않습니다. 중복 없는 별도 이전이 필요합니다.

## 운영 범위

로그인 없는 자동 등록은 등록된 사람의 실제 신원을 보장하지 않습니다.
전송용 키는 설치 단위의 분리와 위조 방지에 사용하며, 공개 웹앱에는 모르는 설치의 등록도 가능합니다.
기본값은 하루 새 등록 50개, 전체 인증 요청 5,000개, 설치당 요청 500개/20MiB입니다.
Google Apps Script 자체의 실행/동시 실행 한도도 적용되므로 대규모 운영에는 별도 수신 서비스가 필요합니다.
Script Properties의 MC_INTAKE_DAILY_REQUESTS/MC_INTAKE_DAILY_REGISTRATIONS로 관리자 한도를 조정할 수 있습니다.
사용자 차단은 관리자 프로그램의 사용자 차단 기능으로 수집폴더의 admin/control.json에도 반영합니다.
.receiver-auth.json과 state/ingest-credentials.json은 수정하거나 삭제하지 마세요.

웹앱 코드 변경 시 새 버전을 만들고 기존 배포를 수정하면 URL을 유지할 수 있습니다.
배포 URL을 바꿔도 전송용 키는 유지하지만, 수신 폴더/등록 정보 자체를 지우면 재등록 충돌이 생길 수 있습니다.
수신 실패는 로컬 로그/대기함을 유지하며, 서비스 시작·질문 후·10분 주기로 재시도합니다.

공식 안내: https://developers.google.com/apps-script/guides/web
쿼터: https://developers.google.com/apps-script/guides/services/quotas
