using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Xml;
using System.Xml.Linq;
using Stream = System.IO.Stream;

namespace MyCivil3DMcp.Plugin;

// Simple Icons의 Claude·OpenAI SVG 경로만 읽어 그린다. 스크립트·외부 그림은 처리하지 않는다.
internal static class ProviderIcon
{
    public static UIElement Create(string provider, Brush foreground)
    {
        if (provider is not ("claude" or "codex"))
        {
            return new TextBlock { Text = "✦", Foreground = foreground, FontSize = 16, Width = 16 };
        }

        string name = provider == "codex" ? "openai" : "claude";
        string resource = $"ProviderIcons.{name}.svg";
        using Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException($"아이콘 리소스 누락: {resource}");
        XmlReaderSettings settings = new() { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
        using XmlReader reader = XmlReader.Create(stream, settings);
        XDocument svg = XDocument.Load(reader);
        Canvas canvas = new() { Width = 24, Height = 24 };
        Brush color = provider == "claude" ? new SolidColorBrush(Color.FromRgb(217, 119, 87)) : foreground;
        foreach (XElement path in svg.Descendants().Where(element => element.Name.LocalName == "path"))
        {
            string data = path.Attribute("d")?.Value ?? "";
            canvas.Children.Add(new System.Windows.Shapes.Path { Data = Geometry.Parse("F1 " + data), Fill = color });
        }

        return new Viewbox { Width = 14, Height = 14, Child = canvas, Stretch = Stretch.Uniform };
    }
}
