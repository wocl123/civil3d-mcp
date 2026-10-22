using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using MyCivil3DMcp.Plugin;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ChatPanel panel = new();
        Call(panel, "ChooseAsync", "claude");
        Click(panel, "설치");
        Check(PaletteApiClient.SetupAction == "install", "Missing CLI must use install action.");
        Check(Field<string>(panel, "_pendingSetupProvider") == "claude", "Remember setup before selection.");
        Check(Field<string>(panel, "_selected") is null, "Missing CLI must not become selected.");

        PaletteApiClient.Actual["claude"] = "ready";
        Click(panel, "↻");
        Check(Field<string>(panel, "_selected") == "claude", "Refresh must select the newly authenticated AI.");
        Check(Field<string>(panel, "_pendingSetupProvider") is null, "Successful setup must clear pending state.");

        PaletteApiClient.Actual["codex"] = "unauthenticated";
        Call(panel, "ChooseAsync", "codex");
        Click(panel, "로그인");
        Check(PaletteApiClient.SetupAction == "login", "Installed CLI must use login only.");
        Click(panel, "↻");
        Check(Field<string>(panel, "_pendingSetupProvider") == "codex", "Incomplete login must remain pending.");
        Check(Field<string>(panel, "_selected") != "codex", "Incomplete login must not become usable.");

        PaletteApiClient.Actual["codex"] = "ready";
        PaletteApiClient.CheckFails = true;
        Click(panel, "↻");
        Check(Field<string>(panel, "_pendingSetupProvider") == "codex", "Network failure must preserve retry target.");
        Check(!Field<bool>(panel, "_busy"), "Refresh failure must release controls.");
        PaletteApiClient.CheckFails = false;
        Click(panel, "↻");
        Check(Field<string>(panel, "_selected") == "codex", "Refresh retry must complete login.");

        Call(panel, "ChooseAsync", "gemini");
        PaletteApiClient.Opened = false;
        Click(panel, "설치");
        Check(Button(panel, "설치").IsEnabled, "Failed launch must allow retry.");
        Check(Field<string>(panel, "_pendingSetupProvider") is null, "Failed launch must not track a new setup.");
        PaletteApiClient.Opened = true;
        Click(panel, "설치");
        Check(Field<string>(panel, "_pendingSetupProvider") == "gemini", "Launch retry must track the correct AI.");
        int checks = PaletteApiClient.Checks;
        Call(panel, "SetBusy", true);
        Call(panel, "RefreshConnectionAsync");
        Check(PaletteApiClient.Checks == checks, "Busy refresh must not start a concurrent check.");
        Check(!Field<Button>(panel, "_refresh")!.IsEnabled, "Refresh button must disable while busy.");
        Call(panel, "SetBusy", false);
        Console.WriteLine("Provider setup passed: install/login actions, refresh before selection, incomplete login, network retry, launch retry, busy guard.");
    }

    private static T? Field<T>(ChatPanel panel, string name) =>
        (T?)typeof(ChatPanel).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(panel);

    private static void Call(ChatPanel panel, string name, params object[] args)
    {
        object? result = typeof(ChatPanel).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(panel, args);
        if (result is Task task)
        {
            task.GetAwaiter().GetResult();
        }
    }

    private static Button Button(ChatPanel panel, string label) =>
        Descendants(panel).OfType<Button>().Last(button => button.Content as string == label);

    private static void Click(ChatPanel panel, string label) =>
        Button(panel, label).RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));

    private static IEnumerable<DependencyObject> Descendants(DependencyObject parent)
    {
        foreach (object child in LogicalTreeHelper.GetChildren(parent))
        {
            if (child is DependencyObject dependency)
            {
                yield return dependency;
                foreach (DependencyObject nested in Descendants(dependency))
                {
                    yield return nested;
                }
            }
        }
    }

    private static void Check(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
