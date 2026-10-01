Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir

q = Chr(34)
electronExe = appDir & "\node_modules\electron\dist\electron.exe"

If fso.FileExists(electronExe) Then
  cmd = q & electronExe & q & " " & q & appDir & q
  shell.Run cmd, 1, False
Else
  cmd = "node " & q & appDir & "\node_modules\electron\cli.js" & q & " " & q & appDir & q
  shell.Run cmd, 0, False
End If
