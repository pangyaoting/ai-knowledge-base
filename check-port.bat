@echo off
rem Fast TCP port probe (500ms timeout). Exit 0 if port open, 1 otherwise.
rem Replacement for Test-NetConnection which hangs 10-20s per probe on closed ports.
rem Usage: call check-port.bat 5432
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{ $r=$c.ConnectAsync('127.0.0.1',%1).Wait(500); if($r -and $c.Connected){ exit 0 } }catch{} finally{ $c.Dispose() }; exit 1"
