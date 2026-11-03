' Double-click to start ORBIX (builds the desktop app on first run, applies staged updates).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\bin\ORBIX.exe"
staged = exe & ".new"
sh.CurrentDirectory = root
If fso.FileExists(staged) Then
  On Error Resume Next
  If fso.FileExists(exe) Then fso.DeleteFile exe, True
  fso.MoveFile staged, exe
  On Error GoTo 0
End If
If Not fso.FileExists(exe) Then
  sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & root & "\tools\build-host.ps1""", 1, True
End If
If fso.FileExists(exe) Then
  sh.Run """" & exe & """", 1, False
Else
  MsgBox "ORBIX could not be built. Run 'npm run build' in this folder to see why.", 16, "ORBIX"
End If
