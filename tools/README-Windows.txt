eSSL Attendance - Windows program
=================================

START
  1. Copy the "essl-attendance" folder to a permanent place, e.g. C:\essl-attendance
     (not the Downloads folder, and not a folder that gets cleaned).
  2. Double-click essl-attendance.exe.
     A black window opens and your browser shows the app at http://localhost:3000
  3. Sign in with:  admin / admin123   and change the password under Settings.
     Keep the black window open while the app is in use. Closing it stops the app.

FIRST-TIME WINDOWS PROMPTS
  - "Windows protected your PC" (SmartScreen): click "More info" -> "Run anyway".
    The program is not signed with a company certificate, so Windows shows this once.
  - Windows Firewall asks to allow access: tick "Private networks" and click Allow.
    This lets the biometric machines and other PCs on your network reach the app.

YOUR DATA
  Everything is stored in the "data" folder created next to the .exe
  (data\attendance.db). Back up that folder regularly. To move to another PC,
  copy the whole folder.

SETTINGS (optional)
  Rename ".env.example" to ".env" next to the .exe and edit it with Notepad,
  e.g. a different PORT, ADMIN_PASSWORD (first start only) or TIMEZONE.
  Restart the program after a change.

MACHINES
  - TCP/IP machines: the PC must be on the same network as the machines.
  - ADMS (Cloud Server) machines: set the server address to this PC's IP
    (run "ipconfig" to see it) and port 3000. Give this PC a fixed IP.

OTHER PCs
  Other computers on the network can open http://<this PC's IP>:3000

START AUTOMATICALLY
  Press Win+R, type  shell:startup  and press Enter. Put a shortcut to
  essl-attendance.exe in that folder; it then starts when you sign in.
