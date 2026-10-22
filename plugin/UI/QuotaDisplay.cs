using System.Globalization;
using System.Text.Json.Nodes;

namespace MyCivil3DMcp.Plugin;

// 서버의 한도 응답을 화면 값으로 바꾼다. 빠지거나 잘못된 값은 0%로 꾸며 표시하지 않는다.
internal sealed record QuotaDisplay(IReadOnlyList<QuotaWindowDisplay> Windows, string Message, bool Restricted)
{
    public static readonly QuotaDisplay Loading = new([], "사용량 조회 중", false);
    public static readonly QuotaDisplay Failed = new([], "사용량 조회 실패", false);

    public static QuotaDisplay Read(JsonNode? quota)
    {
        List<QuotaWindowDisplay> windows = new();
        foreach (JsonNode? item in quota?["windows"]?.AsArray() ?? [])
        {
            double? used = Number(item?["usedPercent"]);
            double? remaining = Number(item?["remainingPercent"]);
            if (used is null && remaining is not null)
            {
                used = 100 - remaining;
            }

            if (used is null || used is < 0 or > 100)
            {
                continue;
            }

            string label = item?["label"]?.ToString() ?? "사용 한도";
            windows.Add(new QuotaWindowDisplay(label, used.Value, Reset(item?["resetsAt"])));
        }

        bool restricted = quota?["limit"] is not null || quota?["ordinaryUsageAllowed"]?.ToString() == "false";
        string message = quota?["limit"]?["message"]?.ToString() ?? quota?["message"]?.ToString() ?? "";
        if (!windows.Any() && string.IsNullOrWhiteSpace(message))
        {
            message = restricted ? "사용 제한됨" : "한도 정보 없음";
        }

        return new QuotaDisplay(windows.Take(2).ToArray(), message.Split('\n')[0], restricted);
    }

    private static double? Number(JsonNode? value)
    {
        bool parsed = double.TryParse(
            value?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double number);
        return parsed && double.IsFinite(number) ? number : null;
    }

    private static DateTimeOffset? Reset(JsonNode? value) =>
        DateTimeOffset.TryParse(value?.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.None, out var reset)
            ? reset : null;
}
