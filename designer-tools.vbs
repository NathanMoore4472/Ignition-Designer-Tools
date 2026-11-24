Set WshShell = CreateObject("WScript.Shell")
' Set working directory to the folder containing this .vbs file
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

' Run pythonw.exe without showing any window (0 = hidden, False = don't wait)
WshShell.Run "pythonw.exe ""backgroundScript.py""", 0, False