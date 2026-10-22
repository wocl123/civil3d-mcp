using System.Text.Json.Nodes;
using MyCivil3DMcp.Plugin;

int checks = 0;
void Valid(string json, int count)
{
    var points = ProfileLayoutPoints.Read(JsonNode.Parse(json), 0, 100);
    if (points.Count != count)
    {
        throw new Exception("Wrong point count");
    }

    checks++;
}

void Reject(string json)
{
    try
    {
        ProfileLayoutPoints.Read(JsonNode.Parse(json), 0, 100);
    }
    catch (ArgumentException)
    {
        checks++;
        return;
    }

    throw new Exception("Expected rejection: " + json);
}

Valid("""[{"station":0,"elevation":10},{"station":100,"elevation":20}]""", 2);
Valid("""
    [{"station":0,"elevation":10},{"station":50,"elevation":12,"curveLength":20},
    {"station":100,"elevation":10}]
    """, 3);
Reject("""[{"station":0,"elevation":1}]""");
Reject("""[{"station":20,"elevation":1},{"station":10,"elevation":2}]""");
Reject("""[{"station":0,"elevation":1},{"station":0,"elevation":2}]""");
Reject("""[{"station":-1,"elevation":1},{"station":100,"elevation":2}]""");
Reject("""[{"station":0,"elevation":1},{"station":101,"elevation":2}]""");
Reject("""[{"station":0,"elevation":1,"curveLength":5},{"station":100,"elevation":2}]""");
Reject("""
    [{"station":0,"elevation":1},{"station":50,"elevation":2,"curveLength":100},
    {"station":100,"elevation":1}]
    """);
Reject("""
    [{"station":0,"elevation":1},{"station":40,"elevation":2,"curveLength":30},
    {"station":60,"elevation":1,"curveLength":30},{"station":100,"elevation":1}]
    """);
Reject("""
    [{"station":0,"elevation":1},{"station":50,"elevation":2,"curveLength":0},
    {"station":100,"elevation":1}]
    """);
Reject("""[{"station":0,"elevation":1},{"station":100}]""");
Console.WriteLine($"Profile layout validation: {checks} checks passed.");
