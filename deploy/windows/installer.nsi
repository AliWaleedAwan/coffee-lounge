; CoffeeLounge-Setup.exe (WINDOWS_DEPLOYMENT.md §1; Phase 8 step 8.4): one offline file. Opened
; with no options it is a wizard: on a first install it asks for the shop address, the USB key
; folder, the key passphrase and the owner's password, then runs setup\install.ps1 with a progress
; log. With options (-Unattended, -RestoreFrom ...) it stays as it was: silent, running
; install.ps1 in a console and passing them on. Secrets reach install.ps1 only through this
; process's environment, never its command line, and go when the installer exits.
; Built by build-installer.ps1:  makensis /DVERSION=x.y.z /DBUNDLE=<dir> /DOUTFILE=<exe> installer.nsi

Unicode true
!include "FileFunc.nsh"
!include "x64.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef BUNDLE
  !error "Pass /DBUNDLE=<bundle folder>"
!endif
!ifndef OUTFILE
  !define OUTFILE "CoffeeLounge-Setup-${VERSION}.exe"
!endif

Name "Coffee Lounge ${VERSION}"
; The default keeps the places used before; any other folder holds everything (owner, Nov 2026).
InstallDir "$PROGRAMFILES64\CoffeeLounge"
OutFile "${OUTFILE}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ManifestSupportedOS all

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Coffee Lounge"
VIAddVersionKey "CompanyName" "Coffee Lounge"
VIAddVersionKey "FileDescription" "Coffee Lounge installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Coffee Lounge"

Var IsUpgrade
Var ShopIp
Var KeyDir
Var Passphrase
Var Owner
Var F1
Var F2
Var F3
Var F4
Var PgAsk
Var PgPass
Var DefaultDir
Var PgOwn
Var RUse
Var ROwn

!define MUI_ABORTWARNING
!define MUI_ICON "..\..\apps\desktop\assets\icon.ico"
!define MUI_UNICON "..\..\apps\desktop\assets\icon.ico"
!define MUI_WELCOMEPAGE_TITLE "Install Coffee Lounge"
!define MUI_WELCOMEPAGE_TEXT "This installs everything the shop needs on this PC: the database, the server and the counter app. Nothing else needs to be installed and no internet is needed.$\r$\n$\r$\nFor a first install, have ready a folder for the owner's keys: a USB key is best, but any folder the owner keeps safe will do."
!define MUI_FINISHPAGE_TITLE "Coffee Lounge is ready"
!define MUI_FINISHPAGE_TEXT "It starts by itself with Windows from now on.$\r$\n$\r$\nOn a first install, the owner's recovery code and the shop keys are in the folder you chose. Print the code and keep it in the safe; copy the folder somewhere safe away from this PC."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Coffee Lounge"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenApp

!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE LocationPre
!define MUI_PAGE_HEADER_TEXT "Install to"
!define MUI_PAGE_HEADER_SUBTEXT "The program and all the shop's data go in this folder."
!define MUI_DIRECTORYPAGE_TEXT_TOP "Choose a drive with plenty of free space: at least 10 GB, and the shop's records grow every year. To use another drive, type a folder like D:\Coffee Lounge or click Browse. Updates keep this place."
!insertmacro MUI_PAGE_DIRECTORY
Page custom ShopPage ShopLeave
Page custom SecretsPage SecretsLeave
Page custom DatabasePage DatabaseLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${GetParameters} $R0
  StrCmp $R0 "" +2
    SetSilent silent
  StrCpy $DefaultDir "$PROGRAMFILES64\CoffeeLounge"
  ; Where an earlier install put its data (the registry), else the default place.
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\CoffeeLounge" "DataDir"
  ReadRegStr $1 HKLM "SOFTWARE\CoffeeLounge" "InstallDir"
  SetRegView 32
  ${If} $0 == ""
    ExpandEnvStrings $0 "%ProgramData%"
    StrCpy $0 "$0\CoffeeLounge"
  ${EndIf}
  StrCpy $IsUpgrade 0
  ; Finished installs only: one that stopped half way still needs the USB folder and passwords.
  ${If} ${FileExists} "$0\config\server.env"
  ${AndIf} ${FileExists} "$0\config\tls\server.pem"
    StrCpy $IsUpgrade 1
  ${EndIf}
  StrCpy $ShopIp "192.168.100.250"
  StrCpy $KeyDir "$DOCUMENTS\Coffee Lounge keys"
  ; Is there a PostgreSQL 17 on this PC already? Then its postgres password is asked.
  StrCpy $PgAsk "no"
  ${If} $IsUpgrade == 0
    InitPluginsDir
    SetOutPath "$PLUGINSDIR\detect"
    File "${BUNDLE}\setup\lib.ps1"
    File "${BUNDLE}\setup\detect-postgres.ps1"
    File "${BUNDLE}\setup\check-postgres-password.ps1"
    File "${BUNDLE}\setup\reset-postgres-password.html"
    ${If} ${RunningX64}
      ${DisableX64FSRedirection}
    ${EndIf}
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\detect\detect-postgres.ps1"'
    Pop $1
    Pop $2
    ${If} ${RunningX64}
      ${EnableX64FSRedirection}
    ${EndIf}
    ${If} $1 == 0
      StrCpy $PgAsk $2 3
    ${EndIf}
  ${EndIf}
FunctionEnd

; Asked on a first install only: an update keeps the place chosen then.
Function LocationPre
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
FunctionEnd

Function ShopPage
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Shop details" "Where the system can be found, and where the keys go."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "This PC's fixed address on the shop network:"
  Pop $0
  ${NSD_CreateText} 0 13u 50% 13u "$ShopIp"
  Pop $F1
  ${NSD_CreateLabel} 0 36u 100% 12u "Folder for the owner's keys (a USB key is best, any safe folder will do):"
  Pop $0
  ${NSD_CreateDirRequest} 0 49u 75% 13u "$KeyDir"
  Pop $F2
  ${NSD_CreateBrowseButton} 77% 49u 23% 13u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseKey
  nsDialogs::Show
FunctionEnd

Function BrowseKey
  Pop $0
  nsDialogs::SelectFolderDialog "Choose a folder for the owner's keys" ""
  Pop $0
  StrCmp $0 error +2
    ${NSD_SetText} $F2 "$0"
FunctionEnd

Function ShopLeave
  ${NSD_GetText} $F1 $ShopIp
  ${NSD_GetText} $F2 $KeyDir
  ${If} $ShopIp == ""
    MessageBox MB_ICONEXCLAMATION "Enter this PC's address."
    Abort
  ${EndIf}
  ${If} $KeyDir != ""
    CreateDirectory "$KeyDir"
  ${EndIf}
  ${IfNot} ${FileExists} "$KeyDir\*.*"
    MessageBox MB_ICONEXCLAMATION "Choose a folder for the owner's keys that can be written to."
    Abort
  ${EndIf}
FunctionEnd

Function SecretsPage
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Passwords" "These are not stored in the installer, and cannot be read back."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "Passphrase for the shop keys (at least 12 characters):"
  Pop $0
  ${NSD_CreatePassword} 0 13u 70% 13u ""
  Pop $F1
  ${NSD_CreateLabel} 0 32u 100% 12u "The same passphrase again:"
  Pop $0
  ${NSD_CreatePassword} 0 45u 70% 13u ""
  Pop $F2
  ${NSD_CreateLabel} 0 66u 100% 12u "Password for the owner, to log in with (at least 10 characters):"
  Pop $0
  ${NSD_CreatePassword} 0 79u 70% 13u ""
  Pop $F3
  nsDialogs::Show
FunctionEnd

Function SecretsLeave
  ${NSD_GetText} $F1 $Passphrase
  ${NSD_GetText} $F2 $0
  ${NSD_GetText} $F3 $Owner
  StrLen $1 $Passphrase
  ${If} $1 < 12
    MessageBox MB_ICONEXCLAMATION "The passphrase needs at least 12 characters."
    Abort
  ${EndIf}
  ${If} $0 != $Passphrase
    MessageBox MB_ICONEXCLAMATION "The two passphrases do not match."
    Abort
  ${EndIf}
  StrLen $1 $Owner
  ${If} $1 < 10
    MessageBox MB_ICONEXCLAMATION "The owner's password needs at least 10 characters."
    Abort
  ${EndIf}
FunctionEnd

; Only when this PC already has PostgreSQL 17: use it (its password is checked here, before
; anything is installed), or run our own beside it, which needs no password.
Function DatabasePage
  ${If} $IsUpgrade == 1
  ${OrIf} $PgAsk != "ask"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Database" "This PC already has PostgreSQL 17."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 20u "Coffee Lounge can keep its data in it, or run its own database beside it. Both work the same; nothing of the existing one is removed."
  Pop $0
  ${NSD_CreateRadioButton} 0 26u 100% 12u "Use it. Its 'postgres' password:"
  Pop $RUse
  ${NSD_CreatePassword} 12u 40u 60% 13u ""
  Pop $F4
  ${NSD_CreateRadioButton} 0 62u 100% 12u "I don't know the password: run Coffee Lounge's own database (no password needed)"
  Pop $ROwn
  ${NSD_CreateLink} 0 86u 100% 12u "Forgot the password? Step-by-step help to reset it"
  Pop $0
  ${NSD_OnClick} $0 ResetHelp
  ${If} $PgOwn == 1
    ${NSD_Check} $ROwn
  ${Else}
    ${NSD_Check} $RUse
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ResetHelp
  Pop $0
  ExecShell "open" "$PLUGINSDIR\detect\reset-postgres-password.html"
FunctionEnd

Function DatabaseLeave
  ${NSD_GetState} $ROwn $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $PgOwn 1
    StrCpy $PgPass ""
    Return
  ${EndIf}
  StrCpy $PgOwn 0
  ${NSD_GetText} $F4 $PgPass
  ${If} $PgPass == ""
    MessageBox MB_ICONEXCLAMATION "Enter the password, or choose to run Coffee Lounge's own database."
    Abort
  ${EndIf}
  ; Checked now, so a typing mistake never stops the install half way.
  System::Call 'Kernel32::SetEnvironmentVariable(t "CL_PG_SUPERPASSWORD", t "$PgPass")'
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\detect\check-postgres-password.ps1"'
  Pop $1
  Pop $2
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariable(t "CL_PG_SUPERPASSWORD", n)'
  StrCpy $2 $2 2
  ${If} $2 != "ok"
    MessageBox MB_ICONEXCLAMATION "That password did not work. Check it and try again, or choose to run Coffee Lounge's own database. The link below the choices explains how to reset it."
    Abort
  ${EndIf}
FunctionEnd

Function OpenApp
  ; Through Explorer, so the app does not inherit the installer's administrator rights.
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\CoffeeLounge" "InstallDir"
  SetRegView 32
  ${If} $0 == ""
    StrCpy $0 "$DefaultDir"
  ${EndIf}
  Exec '"$WINDIR\explorer.exe" "$0\desktop\CoffeeLounge.exe"'
FunctionEnd

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\bundle"
  SetDetailsPrint none
  File /r "${BUNDLE}\*.*"
  SetDetailsPrint both
  ${GetParameters} $R0
  ; NSIS is a 32-bit program: without this, Windows would start the 32-bit PowerShell,
  ; which lacks LocalAccounts and writes HKLM\SOFTWARE under WOW6432Node.
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  StrCpy $R1 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\bundle\setup\install.ps1" -Source "$PLUGINSDIR\bundle"'
  ${If} ${Silent}
    ClearErrors
    ExecWait '$R1 $R0' $0
    IfErrors 0 +2
      StrCpy $0 1
  ${Else}
    ${If} $IsUpgrade == 1
      nsExec::ExecToLog '$R1 -Unattended -Wizard'
      Pop $0
    ${Else}
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_CA_PASSPHRASE", t "$Passphrase")'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_OWNER_PASSWORD", t "$Owner")'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_PG_SUPERPASSWORD", t "$PgPass")'
      ${If} $PgOwn == 1
        System::Call 'Kernel32::SetEnvironmentVariable(t "CL_PG_MODE", t "own")'
      ${EndIf}
      ; In the environment, not the command line: "E:\" would read as an escaped quote.
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_CA_EXPORT_DIR", t "$KeyDir")'
      ${If} $INSTDIR != $DefaultDir
        System::Call 'Kernel32::SetEnvironmentVariable(t "CL_INSTALL_BASE", t "$INSTDIR")'
      ${EndIf}
      nsExec::ExecToLog '$R1 -Unattended -Wizard -ShopIp "$ShopIp"'
      ; The exit code first: nothing else may sit on the stack in between.
      Pop $0
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_CA_EXPORT_DIR", n)'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_CA_PASSPHRASE", n)'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_OWNER_PASSWORD", n)'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_PG_SUPERPASSWORD", n)'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_PG_MODE", n)'
      System::Call 'Kernel32::SetEnvironmentVariable(t "CL_INSTALL_BASE", n)'
    ${EndIf}
    ${If} $0 != 0
      SetOutPath "$TEMP"
      SetDetailsView show
      MessageBox MB_ICONSTOP "The installation did not finish. The steps are listed here, and in the log in the logs folder of the Coffee Lounge data."
      Abort "The installation did not finish."
    ${EndIf}
  ${EndIf}
  ; Leave the temporary folder so it can be deleted when the installer exits.
  SetOutPath "$TEMP"
  SetErrorLevel $0
SectionEnd
