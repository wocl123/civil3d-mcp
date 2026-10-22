using System.Globalization;

namespace MyCivil3DMcp.Plugin;

// 계정 한도 한 구간. 사용률과 재설정까지 남은 시간을 작은 상태줄에 표시한다.
internal sealed record QuotaWindowDisplay(string Label, double UsedPercent, DateTimeOffset? ResetsAt)
{
    public bool Expired(DateTimeOffset now) => ResetsAt is not null && ResetsAt <= now;

    public string PercentText(DateTimeOffset now)
    {
        if (Expired(now))
        {
            return "—";
        }

        if (UsedPercent is > 0 and < 0.1)
        {
            return "<0.1%";
        }

        return UsedPercent.ToString("0.#", CultureInfo.InvariantCulture) + "%";
    }

    public string ResetText(DateTimeOffset now)
    {
        if (ResetsAt is null)
        {
            return "—";
        }

        TimeSpan left = ResetsAt.Value - now;
        if (left <= TimeSpan.Zero)
        {
            return "갱신 필요";
        }

        if (left.TotalDays >= 1)
        {
            return $"{(int)left.TotalDays}d {left.Hours}h";
        }

        if (left.TotalHours >= 1)
        {
            return $"{(int)left.TotalHours}h {left.Minutes}m";
        }

        return left.TotalMinutes >= 1 ? $"{(int)left.TotalMinutes}m" : "<1m";
    }

    public string Detail(DateTimeOffset now)
    {
        string reset = ResetsAt is null ? "재설정 시각 정보 없음" : $"재설정 {ResetsAt.Value.ToLocalTime():MM/dd HH:mm}";
        return $"{Label} 사용 {PercentText(now)} · {reset}";
    }
}
