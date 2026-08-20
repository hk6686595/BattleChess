# Verify matchmaking is temporarily disabled (开发中): match button present but disabled
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Find-Window($title) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $title)
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Find-ButtonLike($win, $contains) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        if ($b.Current.Name -like "*$contains*") { return $b }
    }
    return $null
}

function Invoke-Element($el) {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
}

function Wait-ButtonLike($win, $contains, $tries) {
    for ($i = 0; $i -lt $tries; $i++) {
        $b = Find-ButtonLike $win $contains
        if ($b) { return $b }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

$win = $null
for ($i = 0; $i -lt 10 -and -not $win; $i++) { Start-Sleep -Milliseconds 500; $win = Find-Window '对战平台 · 中国象棋' }
if (-not $win) { Write-Host 'FAIL: window not found'; exit 1 }

# guest -> lobby
$guest = Find-ButtonLike $win '游客体验'
if ($guest) { Invoke-Element $guest }
if (-not (Wait-ButtonLike $win '创建房间' 20)) { Write-Host 'FAIL: lobby'; exit 1 }
Write-Host 'PASS: lobby reached'

# matchmaking temporarily disabled (开发中): button present but DISABLED
$matchBtn = Wait-ButtonLike $win '匹配' 10
if (-not $matchBtn) { Write-Host 'FAIL: match button not found'; exit 1 }
if ($matchBtn.Current.IsEnabled) { Write-Host 'FAIL: match button should be disabled (开发中)'; exit 1 }
Write-Host 'PASS: match button present and disabled'

Write-Host ''
Write-Host 'MATCHMAKING DISABLED VERIFIED'