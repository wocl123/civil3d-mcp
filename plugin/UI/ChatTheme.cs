using System.Runtime.CompilerServices;
using System.Windows.Media;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace MyCivil3DMcp.Plugin;

/// <summary>팔레트 색. Civil 3D 어두운/밝은 테마에 맞춘다.</summary>
// 순서: 배경, 카드, 테두리, 글자, 흐린 글자, 강조, 강조 위 글자, 내 말풍선, AI 말풍선, 오류,
//       상태 점(준비됨, 확인 필요, 사용 불가)
internal sealed record ChatTheme(Brush Background, Brush Surface, Brush Border, Brush Text, Brush Muted,
    Brush Accent, Brush OnAccent, Brush UserBubble, Brush AssistantBubble, Brush Error,
    Brush Ready, Brush Attention, Brush Unavailable)
{
    private static readonly ChatTheme Dark = new(
        Brush("#2B313A"), Brush("#363D48"), Brush("#4A5361"), Brush("#E6E9ED"), Brush("#9EA7B3"),
        Brush("#4C9AFF"), Brush("#FFFFFF"), Brush("#2F6FB3"), Brush("#3C4451"), Brush("#FF8A80"),
        Brush("#4CC38A"), Brush("#E8B04B"), Brush("#7A8390"));

    private static readonly ChatTheme Light = new(
        Brush("#F3F4F6"), Brush("#FFFFFF"), Brush("#D5D9E0"), Brush("#1F2329"), Brush("#6A717B"),
        Brush("#2F6FB3"), Brush("#FFFFFF"), Brush("#2F6FB3"), Brush("#FFFFFF"), Brush("#C62828"),
        Brush("#1E9E62"), Brush("#B7791F"), Brush("#9AA1AB"));

    // COLORTHEME: 0 = 어두운 테마, 1 = 밝은 테마. 못 읽으면 어두운 테마.
    public static ChatTheme Current()
    {
        try { return ReadColorTheme() == 1 ? Light : Dark; }
        catch (System.Exception) { return Dark; }
    }

    // 따로 둔 이유: AutoCAD 런타임이 없을 때 위의 try 안에서 실패하게 하려고(인라인 금지).
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int ReadColorTheme() => Convert.ToInt32(App.GetSystemVariable("COLORTHEME"));

    private static Brush Brush(string hex)
    {
        SolidColorBrush brush = (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;
        brush.Freeze();
        return brush;
    }
}
