namespace MyCivil3DMcp.Plugin;

/// <summary>고르기 결과: picked(폴리선과 함께), cancelled(취소), timeout(시간 초과).</summary>
public sealed record PolylinePick(string Status, PolylineSummary? Polyline);
