namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 도면의 지금 선택: 객체 수, 모두를 종류별·레이어별로 센 것(많은 것부터), 앞 20개의 자세한 정보.
/// </summary>
public sealed record SelectionPage(string DrawingName, int TotalCount, IReadOnlyList<SelectionGroup> ByType,
    IReadOnlyList<SelectionGroup> ByLayer, IReadOnlyList<SelectedObject> Items);

/// <summary>같은 종류(또는 레이어)인 선택 객체 수.</summary>
public sealed record SelectionGroup(string Name, int Count);

/// <summary>선택 객체 하나. Civil 객체는 이름, 2D 폴리선은 요약이 함께 있다.</summary>
public sealed record SelectedObject(string Handle, string Type, string Layer, string? Name, PolylineSummary? Polyline);
