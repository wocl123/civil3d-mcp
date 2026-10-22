# Civil 기능 구현

선형은 `Alignment/`, 종단은 `Profile/`, 지표면은 `Surface/`에서 관리한다. 관련 모델도 각 기능의 `Models/`에 둔다. 관망은 `Network/Gravity/`와 `Network/Pressure/`로 구분한다.

공통 객체 접근·좌표는 `Shared/`, 미리 보기·적용·일괄 실행과 작업 등록은 `Workflow/`에 둔다. 파일 이동 시 기존 CLR 네임스페이스는 유지한다.

전체 카테고리와 서버 대응 경로는 [코드 구조 안내](../../docs/코드구조.md)를 따른다.
