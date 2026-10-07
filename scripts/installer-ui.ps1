param([ValidateSet('Install','Uninstall')][string]$Mode = 'Install', [string]$PreviewPath)
$ErrorActionPreference = 'Stop'
# 콘솔을 숨겨 실행하므로 창 초기화 실패도 사용자에게 대화상자로 알린다.
trap {
 Add-Type -AssemblyName PresentationFramework
 [void][Windows.MessageBox]::Show($_.Exception.Message, 'My Civil 3D MCP 오류', 'OK', 'Error')
 exit 1
}
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
# 화면과 설치 작업을 분리하여 검증/복사 중에도 창이 응답하도록 한다.
[xml]$markup = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="My Civil 3D MCP 설치" Width="660" Height="540" ResizeMode="NoResize" WindowStartupLocation="CenterScreen" Background="#111827" Foreground="#F8FAFC" FontFamily="Malgun Gothic" FontSize="14">
 <Window.Resources><Style TargetType="Button"><Setter Property="Foreground" Value="White"/><Setter Property="Background" Value="#2563EB"/><Setter Property="BorderThickness" Value="0"/><Setter Property="Padding" Value="24,12"/><Setter Property="Cursor" Value="Hand"/><Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button"><Border Background="{TemplateBinding Background}" CornerRadius="8" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center"/></Border></ControlTemplate></Setter.Value></Setter></Style></Window.Resources>
 <Grid Margin="32"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
 <StackPanel><TextBlock Text="CIVIL 3D + AI" Foreground="#60A5FA" FontWeight="Bold" FontSize="12"/><TextBlock Text="My Civil 3D MCP" FontSize="30" FontWeight="Bold" Margin="0,8,0,4"/><TextBlock x:Name="Subtitle" Text="Civil 3D에서 AI와 함께 작업하세요." Foreground="#94A3B8" FontSize="16"/></StackPanel>
 <Border Grid.Row="1" Background="#1E293B" CornerRadius="12" Padding="20" Margin="0,24,0,20"><StackPanel><TextBlock x:Name="StatusTitle" Text="설치 준비 완료" FontWeight="Bold" FontSize="18"/><TextBlock x:Name="StatusText" Text="Civil 3D 2025용 플러그인과 실행 환경을 설치합니다." Foreground="#CBD5E1" TextWrapping="Wrap" Margin="0,8,0,14"/><ProgressBar x:Name="Progress" Minimum="0" Maximum="4" Height="6" Background="#334155" Foreground="#3B82F6" BorderThickness="0"/><TextBlock x:Name="StepText" Text="준비 → 검증 → 복사 → 설치 완료" Foreground="#94A3B8" FontSize="12" Margin="0,10,0,0"/></StackPanel></Border>
 <StackPanel Grid.Row="2"><TextBlock x:Name="LocationLabel" Text="설치 위치" Foreground="#94A3B8" FontSize="12"/><TextBlock x:Name="Destination" Foreground="#CBD5E1" FontSize="12" TextWrapping="Wrap" Margin="0,5,0,12"/><TextBlock x:Name="Hint" Text="설치가 끝나면 Civil 3D를 실행하세요.&#10;처음 질문할 때 사용할 AI를 선택하고 로그인합니다." Foreground="#94A3B8" FontSize="12" TextWrapping="Wrap"/></StackPanel>
 <Grid Grid.Row="3" Margin="0,16,0,0"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><TextBlock Text="Civil 3D 2025 · Windows 64-bit" Foreground="#64748B" FontSize="11" VerticalAlignment="Center"/><Button x:Name="CloseButton" Grid.Column="1" Content="닫기" Background="#334155" Margin="0,0,10,0"/><Button x:Name="InstallButton" Grid.Column="2" Content="설치 / 업데이트"/></Grid>
 </Grid>
</Window>
"@
$window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($markup))
$c = @{}
foreach ($name in @('StatusTitle','StatusText','Progress','StepText','Destination','Hint','CloseButton','InstallButton','Subtitle','LocationLabel')) {
 $c[$name] = $window.FindName($name)
 if (-not $c[$name]) { throw "설치 화면 구성 누락: $name" }
}
$c.Destination.Text = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\MyCivil3DMcp.bundle'
# 설치/삭제 창은 같은 디자인을 사용하며 문구와 실행 대상만 모드에 따라 정한다.
$copy = if ($Mode -eq 'Uninstall') {
 @{
  Action='삭제'; Ready='My Civil 3D MCP 삭제'; Description='설치된 My Civil 3D MCP를 이 PC에서 제거합니다.'
  Steps='실행 확인 → 프로그램 삭제 → 완료'; Count=3; Button='삭제하기'; Script='uninstall.ps1'
  Hint='사용자 데이터와 AI 로그인 설정은 유지됩니다.'
  Running='삭제 중입니다'; Waiting='프로그램을 삭제하고 있습니다. 잠시만 기다려 주세요.'
  Failure='삭제하지 못했습니다'; Success='삭제가 완료되었습니다'
  Complete='My Civil 3D MCP 프로그램이 제거되었습니다.'
  Next='다시 사용하려면 설치.bat을 실행하세요. 사용자 데이터와 AI 로그인 설정은 유지됩니다.'
 }
} else {
 @{
  Action='설치'; Ready='My Civil 3D MCP 설치'; Description='Civil 3D 2025에서 사용할 프로그램을 설치합니다. 이미 설치되어 있으면 업데이트합니다.'
  Steps='파일 확인 → 복사 → 설치 확인 → 완료'; Count=4; Button='설치 / 업데이트'; Script='install.ps1'
  Hint='Civil 3D 2025에서 사용할 수 있습니다. 설치 후 처음 질문할 때 AI를 선택하고 로그인하세요.'
  Running='설치 중입니다'; Waiting='설치 파일을 준비하고 있습니다. 잠시만 기다려 주세요.'
  Failure='설치하지 못했습니다'; Success='설치가 완료되었습니다'
  Complete='이제 Civil 3D 2025에서 My Civil 3D MCP를 사용할 수 있습니다.'
  Next='Civil 3D 2025를 실행하고 AI를 선택한 뒤, 첫 질문을 입력하세요.'
 }
}
$window.Title = "My Civil 3D MCP $($copy.Action)"
$c.StatusTitle.Text=$copy.Ready; $c.StatusText.Text=$copy.Description
$c.StepText.Text=$copy.Steps; $c.Hint.Text=$copy.Hint
$c.InstallButton.Content=$copy.Button; $c.Progress.Maximum=$copy.Count
if ($Mode -eq 'Uninstall') {
 $c.Subtitle.Text='프로그램 삭제를 도와드립니다.'
 $c.LocationLabel.Text='삭제할 프로그램 위치'
 $c.InstallButton.Background=[Windows.Media.BrushConverter]::new().ConvertFromString('#DC2626')
}

# 화면 검증용 렌더링은 설치하거나 실제 창을 표시하지 않는다.
if ($PreviewPath) {
 $window.Content.Measure([Windows.Size]::new(660,540)); $window.Content.Arrange([Windows.Rect]::new(0,0,660,540)); $window.Content.UpdateLayout()
 $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(660,540,96,96,[Windows.Media.PixelFormats]::Pbgra32)
 $bitmap.Render($window.Content)
 $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new(); $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
 $stream = [IO.File]::Create([IO.Path]::GetFullPath($PreviewPath))
 try { $encoder.Save($stream) } finally { $stream.Dispose() }
 return
}
# upToDate: 설치할 것이 없다는 "[완료]" 줄을 받았는지. reinstall: 다음 실행을 [다시 설치]로 하는지.
$state = @{ worker=$null; handle=$null; running=$false; index=0; upToDate=$null; reinstall=$false }
$timer = [Windows.Threading.DispatcherTimer]::new(); $timer.Interval = [TimeSpan]::FromMilliseconds(150)
$c.CloseButton.Add_Click({ $window.Close() })
# 파일 교체 중 닫기로 설치를 중단하지 않도록 완료까지 기다린다.
$window.Add_Closing({ param($sender,$eventArgs) if ($state.running) { $eventArgs.Cancel = $true } })
$c.InstallButton.Add_Click({
 $c.InstallButton.IsEnabled=$false; $c.CloseButton.IsEnabled=$false
 $c.StatusTitle.Text=$copy.Running; $c.StatusText.Text='실행 중인 프로그램을 확인하고 있습니다...'
 $c.StepText.Text=$copy.Waiting
 $c.Progress.Value=0; $c.Progress.IsIndeterminate=$true; $c.Progress.Foreground=[Windows.Media.Brushes]::DodgerBlue
 $state.index=0; $state.running=$true; $state.upToDate=$null
 # 기존 설치 로직을 백그라운드 runspace에서 그대로 실행한다.
 $state.worker=[PowerShell]::Create()
 [void]$state.worker.AddScript('param($installer,$again) if ($again) { & $installer -Reinstall } else { & $installer }').AddArgument((Join-Path $PSScriptRoot $copy.Script)).AddArgument($state.reinstall)
 $state.handle=$state.worker.BeginInvoke(); $timer.Start()
})
$timer.Add_Tick({
 $messages=$state.worker.Streams.Information
 while ($state.index -lt $messages.Count) {
  $message=[string]$messages[$state.index].MessageData; $state.index++
  if ($message -match '^\[(\d)/(\d)\]\s*(.*)') {
   $c.Progress.Value=[int]$Matches[1]-1; $c.StepText.Text="단계 $($Matches[1]) / $($Matches[2])"; $c.StatusText.Text=$Matches[3]
  } elseif ($message -match '^\[완료\]\s*(.*)') { $state.upToDate=$Matches[1] }
 }
 if (-not $state.handle.IsCompleted) { return }
 $timer.Stop(); $failure=$null
 try { [void]$state.worker.EndInvoke($state.handle) } catch { $failure=$_.Exception.Message }
 if ($state.worker.Streams.Error.Count -gt 0) { $failure=($state.worker.Streams.Error | ForEach-Object { $_.ToString() }) -join "`n" }
 $state.running=$false; $c.Progress.IsIndeterminate=$false; $c.CloseButton.IsEnabled=$true
 $state.worker.Dispose(); $state.worker=$null; $state.handle=$null
 if ($failure) {
  $c.StatusTitle.Text=$copy.Failure; $c.StatusText.Text=$failure
  $c.StepText.Text='원인을 확인한 뒤 다시 시도하세요'; $c.InstallButton.Content='다시 시도'; $c.InstallButton.IsEnabled=$true
  $c.Hint.Text='위 안내에 따라 문제를 해결한 뒤 [다시 시도]를 눌러주세요.'
 } elseif ($state.upToDate) {
  # 같은 버전이거나 더 새 버전이 이미 있다: 아무것도 바꾸지 않았다.
  $c.StatusTitle.Text='설치할 것이 없습니다'; $c.StatusText.Text=$state.upToDate
  $c.StepText.Text='변경 없음'; $c.Progress.Value=$copy.Count; $c.Progress.Foreground=[Windows.Media.Brushes]::MediumSeaGreen
  $c.InstallButton.Content='다시 설치'; $c.InstallButton.IsEnabled=$true; $state.reinstall=$true; $c.CloseButton.Content='닫기'
  $c.Hint.Text='지금 설치된 것을 그대로 쓰면 됩니다. 파일이 손상된 것 같을 때만 [다시 설치]를 누르세요.'
 } else {
  $c.StatusTitle.Text=$copy.Success; $c.StatusText.Text=$copy.Complete
  $c.StepText.Text='모든 작업이 완료되었습니다'; $c.Progress.Value=$copy.Count; $c.Progress.Foreground=[Windows.Media.Brushes]::MediumSeaGreen
  $c.InstallButton.Visibility=[Windows.Visibility]::Collapsed; $c.CloseButton.Content='완료'
  $c.Hint.Text=$copy.Next
 }
})
[void]$window.ShowDialog()
