---
description: 관리자 PC에서 내보낸 문제 사례(수정 요청서 .md)를 읽고 고친다. 원인 → 수정 → 회귀 시험 → 전체 시험.
argument-hint: <수정요청서.md 경로>
---

검토자가 관리자 PC에서 내보낸 수정 요청서를 처리한다: `$ARGUMENTS`
(만드는 법: 관리자 PC 팔레트에서 `/검토 사례 내보내기` → `%LOCALAPPDATA%\MyCivil3DMcp\data\admin\수정요청-<날짜>.md`)

순서:
1. 요청서를 읽고 사례별로 무엇이 이상했는지 정리한다(질문, 답, 사용자 의견, 되돌린 변경, 검토자 메모).
   `<이름>`, `<파일>`, `<경로>`는 가림 처리된 도면 이름·경로다. 원래 값을 추측하지 않는다.
2. 사례마다 원인을 찾는다. 코드(server/src, plugin), 설계 기준·규칙(server/knowledge-defaults), AI 지시문(server/skills) 중 어디인지 밝힌다.
   AI가 우연히 틀린 것인지, 도구·계산·지시문이 틀리게 이끈 것인지 구분한다.
3. 고친다. 같은 문제가 다시 나오지 않게 회귀 시험을 더한다:
   - 설계 계산·기준 비교 → `server/scripts/design-regression.mjs` (스냅샷은 `--update` 후 차이를 확인)
   - 도면 변경·삭제·편집 → 해당 시나리오(`delete-scenario`, `edit-scenario`, `safety-regression`)
   - AI가 도구를 잘못 고른 경우 → 지시문(`server/skills/civil3d-palette/SKILL.md`)과 `tool-contract`
4. `server` 폴더에서 `npm run build` 후 관련 시험과 `npm run test:design`을 돌려 모두 통과시킨다.
5. 결과를 표로 보고한다: 사례 번호 · 원인 · 고친 곳 · 더한 시험 · 남은 일(고칠 수 없거나 사용자 착오면 그 이유).
   검토자가 새 버전을 낸 뒤 팔레트에서 `/검토 사례 <번호> 완료 <버전>`을 입력하면 그 사례의 내용이 관리자 보관함에서 지워진다.

커밋·푸시·태그는 하지 않는다(검토자가 결과를 보고 `새버전내기.bat`으로 낸다).
