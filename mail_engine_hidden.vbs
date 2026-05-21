' NOVAPACK Mail Engine launcher — modo WATCH (tiempo real)
' Lanza node mail_engine.js --watch en background sin ventana visible.
' El proceso se queda escuchando Firestore y enviando emails al instante.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\NOVAPACK CLOUD\mail_engine.js"" --watch", 0, False
