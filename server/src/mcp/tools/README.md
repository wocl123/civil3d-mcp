# 기능별 MCP 도구

도구 구현은 alignment, profile, surface, section, corridor, network, point, parcel, featureLine, catchment, propertySet, annotation, drawing, workflow, knowledge 폴더에 둔다. 관망은 network/gravity와 network/pressure로 나눈다.

registration은 기존 도구 등록 순서를 연결한다. 실제 도구 설명·스키마·콜백은 기능 폴더에서 관리한다. shared에는 공통 스키마와 planCivil 실행 경로를 둔다.

도구 이름·설명·입력 기본값은 폴더 구조와 독립적인 외부 계약이다. 이동 시 이 계약과 import 경로를 확인한다. 전체 대응 관계는 [코드 구조 안내](../../../../docs/코드구조.md)를 따른다.
