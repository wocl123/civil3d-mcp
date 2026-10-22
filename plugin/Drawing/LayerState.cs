using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

// 레이어 상태의 전후 값을 계획에 남긴다. 생략한 속성은 편집할 때 그대로 유지한다.
internal sealed record LayerState(short Color, bool Locked, bool Frozen, bool Off)
{
    public static LayerState Read(LayerTableRecord layer) =>
        new(layer.Color.ColorIndex, layer.IsLocked, layer.IsFrozen, layer.IsOff);

    public void Apply(LayerTableRecord layer, bool changeColor = true)
    {
        if (changeColor)
        {
            layer.Color = Autodesk.AutoCAD.Colors.Color.FromColorIndex(ColorMethod.ByAci, Color);
        }

        layer.IsLocked = Locked;
        layer.IsFrozen = Frozen;
        layer.IsOff = Off;
    }
}
